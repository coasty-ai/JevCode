# JevCode TUI round 5 — implementation design (every session knows the others, pause/resume/end exact everywhere, a relaxed visible context, import at onboarding, every provider key one search away)

Written 2026-09-22 against this worktree (`.claude/worktrees/r5-design`, branch `r5-design`, an ancestor of `main`
`6d46875`). **Every `file:line` below was read in this worktree on 2026-09-22 and is as-seen**, not copied from a
design document; where a peer design's own citation is stale against this checkout the row says so and gives the real
line. Read-only: this round's design touched no file under `src/`.

Inputs: the six round-5 research files under `docs/research/tui/round-5/` — `00-contract-digest.md` (**CD**),
`10-coordination-surface.md` (**R10**), `11-context-meter-compaction.md` (**R11**), `12-agent-tree.md` (**R12**),
`13-import-surface.md` (**R13**), `14-provider-model-picker.md` (**R14**), `15-edge-matrix-and-tests.md` (**R15**) —
plus the three peer designs `docs/COORDINATION-DESIGN.md` (**CO**), `docs/ORCHESTRATION-DESIGN.md` (**OR**) and
`docs/IMPORT-DESIGN.md` (**IM**), and the peer session's answers to CD §D recorded at `CD §E`.
`docs/TUI-DESIGN.md` is `TD §n`, `-2` `TD2 §n`, `-3` `TD3 §n`, `-4` `TD4 §n`.

**Round 5 builds on round 4 and never respecifies it.** The hybrid layout as the default with `ui.renderer:
fullscreen` as the opt-in (TD4 D-S), the `◆ jevcode` strip prefix (D-T), the one command-output grammar
`block(head, rows: BlockRow[], opts)` with `blockWidth(columns)` and the five row kinds (D-U), the engine-item
sentence rewrite and its pin inventory (D-V), `annotateBlock` so a block is the same in all three sinks (D-W),
**"Tab goes deeper, Enter runs what is written, Enter with nothing written walks the list"** (D-X), turns not lines
(D-Y), one diff renderer and the four diff colour roles (D-Z), the hardening set (D-AA) and the three-rung narrow
ladder with `fitRung` (D-AB) are **given**. Round 3's 10-cell right-aligned label gutter with dim continuation
labels (TD3 D-L), the TypeSafe pink roles (D-H), the persistent wordmark (D-I) and the alias rules (D-K) are
**given**. Where round 5 changes one of them the row says which rule it amends.

**Round 5 amends exactly two round-4 rules, both in TD4 §7.10, and nothing else.** (i) TD4 §7.10 edge (2) —
"the segment is the **first** thing dropped when the status line runs out of columns" (`docs/TUI-DESIGN-4.md:2826`)
— is amended: the round-5 `peers` segment carries **unread-message counts**, which outrank git state and the
sparkline, so it sits fifth in `DROP_ORDER`, not first (§2.2). (ii) TD4 §7.10 item (2)'s "one kv row per peer —
`workspace`, `started <t> ago`, `<state>`" (`docs/TUI-DESIGN-4.md:2816–2817`) is **superseded by `/who`**: `PeerView`
(`src/core/types.ts:1904–1909`) is four scalars and cannot produce a per-peer row at all, and TD4 §7.10 is internally
inconsistent on the point (it asks for a `workspace` row and then says "never a path"). `/peers` keeps TD4's
**head-and-empty-state half**, verbatim (§2.4); the per-peer detail is `/who`'s. §15 Q19 files the TD4 doc fix.
Everything else in D-G … D-AB stands untouched.

**Round-4 dependency, stated once.** `docs/TUI-DESIGN-4.md` is designed and ratified (its §0.1) but **not
implemented in this worktree**: `src/tui/commands/registry.ts:102`'s `COMMANDS` array has exactly **37** rows
(counted by the `category:` field, which appears once per row — a naive `name:` count returns 62 because `ArgSpec`
has a `name` too), matching round 4's own "37 → 41" delta rather than the post-round-4 count; `src/tui/block/`,
`src/tui/diff/`, `src/tui/fit.ts` and `src/tui/gutter.ts` do not exist (`ls`, 2026-09-22). Round 5 therefore designs
**on top of round 4's §8 contract 1.7 and §9 module map, not on the code as it is on this branch today**, and every
slot below whose work consumes `blockWidth`/`renderBlock`/`fitRung` states its stub-and-swap fallback (§8.4).

**Contract 1.5 has landed on `main`; this worktree is behind it (`CD §F`, reconciled 2026-09-22).** `git merge-base
--is-ancestor 2400a0c HEAD` → **false** in this worktree (HEAD `d860827`), and `--is-ancestor d8490fa HEAD` → **false**
too, so every "not built, verified by absence" row below is true *of this branch* and **may already be false of
`main`**. Per `CD §F`, `main` at `2400a0c` carries: `ConfirmRequest.title/headline/body/badge` (so §8.2 **R5** is a
confirmation, not a request); `meter.hold(agentId, usd)` / `release(agentId)` / `heldUsd()` / `snapshot().heldUsd`
with `RESTORED_HOLD_ID` (so **R2** is a confirmation); `PausePointReason 'delegate'` (P9) and `'review-needed'`
(P10), `StageName 'decompose'`, the `agent:*` / `decompose:*` / `orchestration:proposed` / `agent:adopted` events
and `EngineOptions.{splitPolicy, orchestration, blocker, confirmer}` (so **R11** is a confirmation); and
`Engine.land(input, ask?)` carrying the `[c]/[s]/[x]` pre-flight. `CD §F` also records the peer's **agreement on
`BlockingKind`**: it is *not* additive, and the peer's W2b agent lands `'land-preflight'` **and** `'lease-conflict'`
together with placeholder case lines in the four TUI-owned spots, in one commit (so **R1** becomes "one harness word
plus four TUI-owned case lines", §8.2). **Round 5's first implementation act is therefore a rebase onto `main` and a
re-verification sweep of §2.0, §3.0, §4.1, §5.0 and §6.0's "built / not built" tables** (gate **G-R5-11**); every
`file:line` in this document is as-seen on `r5-design` and must be re-read after that rebase. `CD §F` additionally
assigns round 5 five TUI-side to-dos, all carried below: the `[G7]` parking blocker (§4.5), the `review:why` refusal
while `headline` is set (§4.6), `src/tui/agents/lines.ts` replacing the engine's `decomposeBody()` (§4.2), `src/undo`'s
`landedUndoOffer` / `rewindRefusal` (§4.5), and the `land-preflight` blocking row designed beside `lease-conflict`
(§2.11).

**Contract number: round 5 is `// contract 1.8`.** `src/core/types.ts:9–14` carries `1.1, 1.2, 1.2, 1.3, 1.4
(coordination), 1.7 (TUI round 4)`; `1.5` (orchestration) and `1.6` (import) are reserved and unlanded.
`docs/DECISIONS.md:1034–1042` in this worktree stops at "1.7 TUI round 4"; `main` has since assigned **1.8 TUI round
5** and **1.9 Fastlane (HARNESS-NEXT)** (commit `aa7dc3c`), which `CD §E` item 5 confirms as the peer's answer. The
one-line `docs/DECISIONS.md` sync happens at merge time; §8's header line says `1.8`.

**Standing constraints every proposal keeps** (§11 names the gate per change): first frame < 300 ms with **zero
network and zero file I/O before it** — and, new this round, **nothing from `src/provider/registry.ts` or
`src/models/**` beyond `src/provider/ids.ts` and `instantCatalogue()` may be reached on the first-frame/argv path**
(§6.2); composer keystroke → frame p95 < 16 ms; render lag p95 < 5 ms while typing during a run; dynamic frames ≤
maxFps + 1 during a run; zero terminal clears outside shrink resizes; `transcript.log` == `--plain` == TUI rows
through `src/tui/plain.ts` or a **declared** normaliser; **keys are never printed or logged** — and, new this round,
neither is a device key, a claim HMAC, a paired-device secret nor an imported credential (§7 rows 61–66); no
auto-approve of reviews; reduced motion / screen reader / `--plain` / `--ascii` / `NO_COLOR` / SSH fps 15 / the flat
tier < 16 rows all keep working; runtime dependencies stay `ink` 7.1.1 + `react` 19.3.0; TypeScript strict, no `any`,
ESM, Node 22.

**Every user-visible behaviour in this document has four twins and a test**: an Ink render, a `--plain` line, a
`--json` shape **where a CLI verb exists**, and a screen-reader / `--ascii` / `NO_COLOR` variant — plus a stated
behaviour at 40, 80 and 120 columns. §12 is the one string table; §13 is the pin inventory; §10 names the test.

**This is the post-review revision.** The design review ran two adversarial passes (contract-feasibility and
ux-edge-cases) and returned sixty findings plus twenty-five named omissions; **§14** is the full record — where
the research files disagreed (§14.1) and what changed or was declined, finding by finding (§14.2). Fifty-eight
findings were applied and two declined, both on citations the review got wrong and this document had right. Seven
of §0's eighteen recommendations were **amended** (none reversed); §0.2 is the table of what changed and why, and
the owner ratifies the amended text in §0, not the original. Three items the review forced are load-bearing enough
to name here: round 5 now opens with a **W−1 rebase onto `main`** because this worktree predates contract 1.5
(§0, gate G-R5-11); §2.14 adds the **write half** of coordination, without which requirement 1 is fixture-only;
and §8.2 **R13** files the reason requirement 3 is currently invisible in the product's default mode.

Read §0 → §0.2 → §1 → §8 → §9 (your slot) → the sections your slot's row names → §14.2 for anything that looks
surprising.

---

## 0. Owner decisions (D-AC … D-AT) and how each is honoured

Eighteen decisions. Round 4 ended at **D-AB**, so round 5 opens at **D-AC**. Nothing in D-G … D-AB (rounds 1–4) is
reopened. Each row states the question, the options weighed, the evidence and this document's recommendation; the
ones marked **ratify** need the owner's word before the slot that lands them starts. §0.1 is the owner's table,
**left empty for the owner to fill in**.

| Decision | The question | Options | Evidence | Recommendation |
| --- | --- | --- | --- | --- |
| **D-AC** *two cross-session commands, or one.* | Does round 4's `/peers` grow into CO §3.6's full activity view, or does `/who` land beside it? | (a) grow `PeerView` into a `SessionActivity`-shaped type and keep one command; (b) keep `/peers` exactly as TD4 §7.10 specifies (count + coarse state, never a pid, never a path) and add `/who` as the full-detail verb; (c) drop `/peers`, rename to `/who`, treat TD4 §7.10 as superseded | `PeerView` is four fields — `live`, `stale`, `oldestStartedMsAgo`, `exclusive` (`src/core/types.ts:1904–1909`), reached through `SessionHost.peers?(): PeerView \| null` (`:1901`). `SessionActivity` (`src/coordination/types.ts:434–458`) is eighteen fields including `heartbeat`, `leases`, a `flags` record of eight booleans and `authority` (`:445`). **`PeerView` carries no per-peer rows at all** — it is a four-scalar aggregate — so TD4 §7.10's "one kv row per peer" clause (`docs/TUI-DESIGN-4.md:2816–2817`) is already unimplementable against it, with or without a `workspace` cell; growing (a) means inventing a row array TD4 never typed, and TD4 §7.10 is itself internally inconsistent (it asks for a `workspace` row and then says "never a path" — §15 Q19 files that doc fix). (c) makes TD4's ratified `/peers` spec a dead string and reintroduces the "never a dead command" defect TD4 §14.2 finding 41 already fixed once | **(b), ratify.** Ship both. `/peers` keeps its four-field, always-safe shape and finally gets a real backing store (§2.4); `/who` is the new, full-detail verb (§2.3). They are different questions — "am I stepping on myself" vs. "what is everyone doing" |
| **D-AD** *which `Ledger` type the TUI holds, and who calls `claimRefusal`.* | Does the TUI type against the 7-member contract `Ledger` or the handle `openLedger()` returns, and does `/resume`'s claim check live in the TUI or wait for `EngineOptions.coordination`? | (a) `Ledger` + a cast at every call site; (b) `LedgerHandle` everywhere, and `resumeRun` calls `claimRefusal` itself before `createEngine`; (c) wait for the harness to add `EngineOptions.coordination` and refuse engine-side | `Ledger` (`src/coordination/types.ts:466–485`) has 7 members; `LedgerHandle extends Ledger` (`src/coordination/ledger.ts:189`) is what `openLedger()` returns (`ledger.ts:1774`) and is the only type carrying `status()`, `forkVerdict()`, `setDeviceLabel()`, `syncStatus()`. `EngineOptions` (`src/core/types.ts:1239`) has **no** `coordination` member; nothing under `src/loop/**`, `src/cli/**` or `src/tui/**` imports `src/coordination/**` at all today. `claimRefusal` (`src/coordination/claims.ts:265`) is built and unit-tested and has **zero callers**. CO §12.0.1 rule 5 already says the caller opens the ledger, never the engine | **(b), ratify.** Type every coordination variable as `LedgerHandle`; `resumeRun` (`src/cli/session.ts:2296`) calls `claimRefusal` in its existing pre-`createEngine` check sequence. (c) blocks a shippable slice on a harness field nobody has started. `CD §E` item 3 confirms the peer's own answer is `LedgerHandle`, with a later alias wave |
| **D-AE** *how much of the target/scope grammar round 5 parses.* | `/pause`, `/end` and `sessions <verb>` share one target grammar that spans coordination (`device:<label>`, run ids, titles) and orchestration (`tree`, `agents`, `agent:<slug>`). Which half lands now? | (a) the whole grammar in one parser now; (b) `[now]` + the coordination target forms now, with the orchestration scopes as one documented, additive union branch; (c) CLI-only `sessions pause`, leave `/pause` alone | `Engine.pause(opts?: PauseOptions)` (`src/core/types.ts:1769`, `PauseOptions` `:1582`) and `Engine.end?(opts?: EndOptions)` (`:1771`, `EndOptions` `:1590`) both exist. `PauseOptions.by` is `'self' \| \`peer:${string}\` \| \`device:${string}\`` (via `PausePoint['by']`, `:1576`) — the coordination half of the grammar has a typed destination **today**. `AgentSupervisor` is not found anywhere in `src/`; `StageName` (`:243`) has no `'decompose'`; so `agent:<slug>` has no referent that can be constructed, let alone exercised | **(b), ratify.** One `resolveTarget` module (§2.5), coordination forms only, with the union's growth point marked by a named type alias so orchestration's later widening is additive. Writing a parser branch for a target kind that cannot be constructed is untestable code |
| **D-AF** *the `lease-conflict` pane: build it, or defer it.* | CO §12.0.2 P6/P7 and §4.3 steps 4–5 describe a blocking pane with `[w]`/`[r]`/`[t]`/`[q]`. There is no `BlockingKind` member for it. | (a) request the one additive union member from the harness early in wave 0 and build the pane; (b) defer the pane to round 6, ship the rest of coordination; (c) build against a TUI-local stand-in type and reconcile later | `BlockingKind` (`src/core/types.ts:1225`) has 6 members, no `'lease-conflict'`. **But `BlockingAnswer` (`:1226`) already has `'wait'` and `'worktree'`, added under contract 1.4 with a comment naming "the lease-conflict pane" explicitly** — so the *answer* half of the pane landed and only the *kind* is missing. `PausePointReason` (`:1543`) already has `'worktree'` and `PausePoint.pane?: BlockingKind` (`:1568`) is already typed | **(a), ratify — with one correction the review made (§14.2 #34): the member is _not_ additive.** `BlockingKind` has three exhaustive TUI-owned consumers with no `default` — `pausedWord` (`src/tui/status/lines.ts:284`), `blockingRowsStructured` (`src/tui/blocking/lines.ts:121`) and `blockingStatusWord` (`:238`) — plus one total `Record<BlockingKind, …>` in `test/unit/tui/pane/blocking.test.ts:58`. `CD §F` records the peer's agreement: its W2b agent lands **`'land-preflight'` and `'lease-conflict'` together, with placeholder case lines in those four spots, in ONE commit**; round 5 restyles the labels and designs both rows' strings, twins and keys (§2.11). Ask for it in wave 0 (§8 REQUEST R1). (c) is rejected on TD4 §14.2's own precedent: a TUI-local stand-in becomes a second source of truth the moment the real member lands. Fallback if the harness cannot fit it: ship §2 without the pane; nothing else in §2 depends on it |
| **D-AG** *where `ctx N%` sits in the status line, and what amber/red look like without colour.* | A new right-zone cell needs a place in the drop order and a non-colour marker. | (a) `'ctx'` as its own `SegmentId` gated at `CONTEXT_MIN_COLUMNS = 100`, dropped **before** `sess`; (b) tie it to the existing `TOKENS_MIN_COLUMNS` gate; (c) unconditional, like `step`/`run`; and for the threshold: colour only / a word / a word **plus** a one-time notice | `SegmentId` (`src/tui/status/lines.ts:401`) is a closed 8-member union; `DROP_ORDER` (`:413`) is `['help','spark','git','sess','wall']`. The precedent is that per-run money is never dropped ahead of anything else. `MeterLevel` already exists as `'ok' \| 'amber' \| 'red'` (`src/loop/context/meter.ts:79`) with the thresholds at `:83–84`. There is **no** `context:warn` engine event (unlike `budget:warn`), so a colour-only signal is invisible to `NO_COLOR`, `--ascii` and screen-reader users — which violates TD §14.1's "a marker beside every colour" rule that TD4 §6.2 already applied to diff rows | **(a) + the word + a one-time notice, ratify — amended by the review on two counts (§14.2 #38, #57).** `'ctx'` joins `SegmentId` and `DROP_ORDER` immediately before `'peers'`/`'sess'`, and it has **two rungs, not one gate**: `ctx 41%` at ≥ **80** columns and the full `formatMeter` form `ctx 41% · 6 files · 12 steps` at ≥ **100** (the same rung pattern `meterText`/`gitZoneText` already use) — a single 100-column gate would leave requirement 3's "visible usage" **absent at 80 columns**, the most common width. Amber/red **replace** the cell with `ctx 87% amber · /compact now` (the files and steps counts are dropped, they are not the point at 87 %) and fire one `engine.annotate()` notice per threshold **per process**, re-announced on a resume, computed client-side from `status.context.pct` exactly as `crossedThresholds` does for money (`src/tui/budget/lines.ts`) — no engine change. Separately: **the cell is empty in the product's default mode.** `DEFAULT_MODE` is `'llm-jev'` (`src/config/defaults.ts:50`) and `engine.ts:922` excludes it from `contextEnabled`, so requirement 3 ships invisible out of the box; §8.2 **R13** asks the harness to include `'llm-jev'`, gated before R5-3's W2, and §1.1 states the interim honestly |
| **D-AH** *where `/context`'s detail comes from.* | `EngineStatus.context` cannot answer "why is this file in view" or "what does the summary say". | (a) `EngineStatus.context` alone; (b) ask the harness for a new `Engine.contextDetail?()`; (c) join three reads that are already public: `engine.status().context`, `engine.snapshotState()` and the run's own `CheckpointStore.readContextSummary()` | `ContextUsage` (`src/core/types.ts:1645–1679`) has **19** members but `files` is a *count* (`:1649`), not a list. `Engine.snapshotState(): CheckpointState \| null` (`:1758`) is synchronous, already used for the last-resort checkpoint write, and its `contextExtension()` helper spreads `fileCache`, `fileMemory`, `history`, `summaryAt`, `compactions`, `lastCompactionAt`. The summary **text** lives only in `<runDir>/context/summary.json`, written atomically by `CheckpointStore.writeContextSummary` (`src/loop/engine.ts:3558`) | **(c), ratify; (b) as a round-6 follow-up if the join proves awkward.** Zero contract change; every piece is already public and already used by `src/cli/session.ts`. **`/context drop <file>` and `/keep <text>` are scoped OUT of round 5** — both are *writes* with no `Engine` member (unlike `/compact`, which has one at `:1779`) |
| **D-AI** *`context.*` config: the schema row, or the whole chain.* | CD row 101 calls the gap "zero rows in the `SETTINGS` schema". It is three layers deep. | (a) add the `SettingName` rows only; (b) add the rows **and** implement `ResolvedConfig.context()` **and** pass `contextPolicy` at the `createEngine` call sites | `SettingName` (`src/config/types.ts:6–63`) has zero `context.*` members. `ResolvedConfig.context?(): ContextPolicyOptions` (`src/core/types.ts:2076`) is **declared**, and its own doc comment claims `config/resolve.ts` "always sets it" — that claim is false: `src/config/resolve.ts` never mentions it. `EngineOptions.contextPolicy?` (`:1248`) is never referenced in `src/cli/session.ts`. So today no flag, key or variable reaches the context policy in a real run | **(b), ratify.** (a) alone ships dead code exactly like the dead hook already in the tree. One PR: five `SettingName` rows, a small resolver mirroring `src/config/ui.ts`, and `contextPolicy: rcfg.context?.()` at each engine-construction site (§3.6) |
| **D-AJ** *the compaction notice: the design's pinned string, or the as-built one.* | CO §8.6 pins `compaction: 41k → 12k chars (code)`. The engine already emits a longer, different line. | (a) change the harness string to match the design pin; (b) keep the as-built string and reconcile the design doc | `src/loop/engine.ts:3567` emits `` `compaction: ${chars.before} → ${chars.after} prompt chars (code); ${folded} at step ${step} (${why})` `` — raw char counts, not `k`; plus the fold count, the step and the trigger reason (`every 8 steps` / `prompt at N% of the context budget` / `resumed past the history window` / `requested`). Its own comment at `:3564–3566` states the rule this document must not break: **"ONE shared line in all three sinks."** `context:compacted` yields no transcript item of its own by design (`:3560–3562`) | **(b), ratify.** The as-built string is strictly more informative, is already identical in all three sinks through `itemsFromEvent`'s generic `notice` case, and is already pinned by `test/unit/loop/engine-context.test.ts`. Changing it would touch harness-owned `engine.ts` for a worse string. Round 5 files the doc fix as §15 Q3 and decorates around the real line, never replacing it |
| **D-AK** *the agents tab: fixture-first, or wait for contract 1.5.* | `// contract 1.5` is not in `src/core/types.ts` **in this worktree** — it **is** on `main` at `2400a0c` (`CD §F`). Does the tab wait? | (a) wait for the merge; (b) build every pure row/card builder against `src/orchestrate/index.ts`'s already-exported types | `src/orchestrate/index.ts:21–46` exports `AgentRef, AgentRole, AgentRow, AgentSpec, DemandReason, GateReason, LandAttempt, Manifest, SplitKind, AgentState, VerifyResult` and thirteen more **today**; `src/orchestrate/types.ts:1–13`'s own header says the move to `core/types.ts` is a **relocation, not a reshape**. `AgentState` (`types.ts:27–43`) is the full 16-member union. OR §4.6's own framing — "every row string is produced by one pure function shared by the Ink tab, the `--plain` twin, the screen-reader twin and `jevcode agents list`" — is by construction supervisor-independent: the function takes an `AgentRow`, not a process | **(b), ratify — unchanged, and now cheaper.** Contract 1.5 landed on `main` at `2400a0c` while this document was being written, so the "re-point to `core/types.js`" swap of §8.4 most likely happens **inside** round 5 rather than after it; building against `src/orchestrate/index.ts` is still correct because that module is where the types live until the relocation commit runs, and the swap is a find-and-replace either way. The tab, its 16 row states and its four cards are built and tested against typed `AgentRow[]` fixtures; `paneTabsFor(hasDelegation)` keeps it invisible in production until real rows exist. `AgentSupervisor` itself does **not** start this round (§4.7) |
| **D-AL** *`/end`: ship the single-run form now, or bundle it with the scope grammar.* | CD's A1 table marks `Engine.end?()` "unverified, likely NOT YET". | (a) bundle with `tree`/`agent:<slug>`; (b) ship `/end [now]` for one run now | **Correction to CD.** `Engine.end?(opts?: EndOptions): void` **exists** at `src/core/types.ts:1771`; `EndOptions` at `:1590`; `RunEnded` at `:1597`; `PausePoint.end: boolean` at `:1578`. All landed under contract 1.4. What is missing is the *command row*, the confirm ladder and the `session:end` index kind — not the engine method | **(b), ratify.** An early, low-risk win that exercises the `RunMeta.ended` → `/resume --force` path before any of the harder work. The scope grammar widens it later, additively (D-AE) |
| **D-AM** *the manifest confirm fields: alone first, or with their consumer.* | `ConfirmRequest.title/headline/body/badge` (OR §3.7) touch five count-preserving render branches. | (a) land the four fields and the five branches alone, proven by a synthetic fixture; (b) land them in the same PR as the agents tab | `ConfirmRequest` (`src/core/types.ts:693–702`) is `{ id, step, proposal, risk, matchesIntent?, jevLatencyMs? }` with `proposal` and `risk` **required**; `CONFIRM_HEADER_ROWS = 8` (`src/tui/plain.ts:517`). The property OR §3.7 wants — "no rendered row contains any substring of `risk` or `proposal`" — has nothing to do with agents | **(a), ratify.** Landing the five-branch substitution against the existing review card de-risks the trickiest rendering work in round 5 without needing a working supervisor to exercise it. This mirrors TD4 §9.3 W1's own "pure modules first" convention |
| **D-AN** *a command that has no backing store yet: register it, or omit it.* | Round 5 adds up to fifteen command rows whose stores land over three waves. | (a) omit each row until its store exists; (b) register every row now with an honest "not available in this build" answer | TD4 §7.10 already set this precedent for `/peers` and pinned its sentence (`the peer registry is not available in this build`); TD4 §14.2 finding 41 records that a *dead pointer* to a command that does not exist is the defect this rule prevents. `availabilityError` (`src/tui/commands/registry.ts:599`) generates the idle/live refusals for free from `CommandSpec.availableDuringTask` | **(b), ratify.** Every round-5 command row lands with the wave that lands the registry PR (§9.2), answering honestly until its store exists. This keeps `docs/COMMANDS.md`, the palette, the `--plain` numbered list and the command-count identity test in sync from the first commit |
| **D-AO** *the import overlay and report: round 4's block grammar, or a bespoke renderer.* | IM §5.2/§5.5 was written before D-U existed and mocks pre-formatted strings. | (a) bespoke row formatting in `src/tui/import/lines.ts`; (b) `BlockRow[]` through `renderBlock`/`blockWidth`, stubbed until round 4's `block/**` lands | The user's round-4 request that motivated D-U ("the output of the commands look super clean … nice separated") applies with equal force to a 41-row import report. `src/tui/block/` does not exist in this worktree; IM's own §7.7 already uses the stub-and-swap trick for a different dependency | **(b), ratify.** Build against a stub `block/lines.ts` with round 4's exact signatures (§8.4), swap in the real module when round 4 lands. A second string-formatting convention for one command family, landed the same week round 4 unifies the other 24 call sites, is the exact drift D-U exists to prevent |
| **D-AP** *widen `GeneratorConfig.provider` / `ProviderName` to all seven ids, or keep the picker browse-only.* | Five provider adapters exist and are unreachable. | (a) widen both unions this round as contract 1.8's own entry and delete the two-name check; (b) ship the picker catalogue-only, with a "browse only" refusal for the five new ids | `ProviderId` is a 7-member union (`src/provider/ids.ts:18`) with `PROVIDER_IDS` (`:25`) and per-provider env names in lookup order (`:36–44`). Seven real adapters and seven `PROVIDERS` rows exist. But `ProviderName` (`src/core/types.ts:649`) and `GeneratorConfig.provider` (`:2005`) are still two-member, and `src/config/validate.ts:161` throws `one of anthropic\|openrouter` for anything else. `src/provider/registry.ts:16–19`'s own CONTRACT NOTE is explicit on both points: it opens **"(src/core/types.ts is owned by the TUI/session round)"** and says widening those two core unions to `ProviderId` "makes `createProvider()` return exactly a core `Provider` with no other change here" | **(a), ratify.** One union widening plus one deleted check unblocks five finished adapters. (b) means writing the "browse only" refusal copy and then deleting it. The harness's own comment already assigns these two lines to this session, so this is **contract 1.8 item 6**, not a request — §8.2 R9 keeps a confirmation row only |
| **D-AQ** *where the model picker lives, and whether it gets a chord.* | Hundreds of catalogue rows need fuzzy search, a provenance row per provider and a background refresh. | (a) grow the palette's static `ArgSpec.values` machinery to a dynamic source; (b) a dedicated pane-slot picker mirroring `/resume`; and separately: bind `Ctrl+L`, or not | TD4 §4.2's `PaletteNavState` reads a **compile-time** `spec.args[0].values: readonly string[]`; `/mode` has 4 values and `/budget` has 6 (`BUDGET_SETTINGS`, `registry.ts`) — the machinery was sized for a handful. `/resume` is already the in-repo precedent for "bare command opens a dedicated picker filtered by the composer text" (`src/session/picker-lines.ts`). **`Ctrl+L` is already bound**: `src/tui/keys/bindings.ts:70` `global:repaint`, "repaint the dynamic region (erase-lines + rewrite, never a clear)" | **(b) + no chord, ratify.** A dedicated overlay; reached through `/model` and the palette's Enter-cycling exactly like every other command (D-X). `Ctrl+L` is taken by repaint in this product and is clear-screen in aider/Qwen/Cline; a chord collision is worse than a missing shortcut |
| **D-AR** *key setup for five new providers: through the wizard, or beside it; priced probe or free check; one saved key or many.* | Three coupled sub-questions with one answer shape. | (a) widen `WizardProvider` to seven and add five `KEY_PREFIXES`; (b) leave the hardened wizard binary and add the other five through `/provider <id>` + `jevcode login --provider <id>`; and: priced decider probe vs. free catalogue GET; single `apiKey` slot vs. a per-provider map | `WizardStep` (`src/tui/onboarding/reducer.ts:26`) is a 13-member state machine with three rounds of documented edge-case hardening (paste-twice, pasted-newline-as-Enter, OpenRouter-key-reuse-for-Jev). `verifyProvider` (`src/models/verify.ts:37`) is free, provider-agnostic across all seven, redacted by construction, and returns `{ ok, latencyMs, via, modelCount?, error? }`; the wizard's current verify spends a real Jev decision plus a 1-token completion. `CredentialsFile` holds one `apiKey` + one `provider` (`src/config/credentials.ts:115–123`), and `PROVIDER_KEY_ENV` already gives a power user every provider at once through the environment | **(b) + free check + single slot, ratify.** None of the wizard's documented edges are provider-specific in a way five more branches simplify; all of them multiply. Spending a token to prove an OpenAI key can *list models* is indefensible. The credentials-file migration buys one convenience (skip re-pasting on `/provider`) at the cost of touching `jevcode logout`, `--config` and every existing file — revisit if `/provider` cycling turns out to be frequent |
| **D-AS** *`INDEX_KINDS`: three designs, one array.* | Coordination wants `session:end`/`relocate`/`handoff`, orchestration `agent:start`/`agent:end`/`land`, import `import`. | (a) whichever slot is ready lands its own and the rest rebase; (b) one owner lands all seven in one commit at the end of the wave; (c) coordination lands its three first and the others append | `INDEX_KINDS` (`src/session/index.ts:36`) is `['run:start','run:end','rename','steer','undo','pause','budget','chat']` — 8 entries, typed `readonly string[]`, **not** a literal union, so nothing type-checks a bad kind string. `IndexLine` (`:24–34`) is the discriminated union that must gain one arm per kind. `docs/DECISIONS.md`'s 2026-09-22 entry already records the cost of two sessions racing one shared file. `CD §E` item 7 fixes the seven names as final | **(b), ratify — and the commit _acts_ on the evidence (§14.2 #18).** One commit, one owner (slot **R5-1**, which owns `src/session/**`), seven kinds, seven `IndexLine` arms, landed as the **last** commit of the wave once every contributing slot has posted its exact row text. The same commit **exports `INDEX_KINDS` and re-types it `readonly IndexKind[]`** — it can be, now that `IndexKind = IndexLine['kind']` exists at `src/session/index.ts:35` — so a kind absent from the union is a compile error and §10's membership test and gate G-R5-10 have something to import (today `const INDEX_KINDS: readonly string[]` at `:36` is module-private and type-checks nothing). The two widened arms (`by`, `parentSessionId`) are **optional**, with stated reader defaults (§2.6). Appending is safe — `INDEX_KINDS` is read by membership, never by position |
| **D-AT** *concurrent git operations: today's unhandled throw, or a named error.* | A sibling agent or a second session holding `.git/index.lock` is routine once the tree exists. | (a) leave as-is; (b) classify `index.lock`/`EAGAIN`/`EBUSY` the way `src/checkpoint/store.ts` already classifies disk faults, and surface a named, recoverable error | `grep -n "index.lock\|EAGAIN\|EBUSY" src/workspace/gitstate.ts src/workspace/patch.ts` returns **nothing** in this worktree — a raw git stderr string reaches the user today. `src/checkpoint/store.ts` already has `classifyDiskError`/`DiskError` and `checkpointDegradedSentence` one module over, and TD4 §7.4's `explainFsError` set the bar: "errors that name the fix" | **(b), ratify.** The agent tree makes sibling git collisions ordinary rather than rare, and the pattern already exists one module over. Small, self-contained, and it makes §7 rows 44–46 testable |

**Kept from TD/TD2/TD3/TD4, untouched:** one modal slot; one `computeLayout` in classic; `<Static>` the only
scrollback writer in classic; `lines()` twins; no new dependency; Jev decides; the review invariants
(`test/unit/tui/app.test.tsx:342–461`, only `y` approves, Enter inert); `itemsFromEvent`/`formatTranscriptItem` as the
one item source; `useAnimation(` only in `motion.ts`, `setInterval(` only in `spinner.ts`/`retry.ts`; the 10-cell
gutter with dim continuation labels; the `◆ jevcode` strip prefix; palette Enter-cycling. `src/synth/**`,
`src/bench/**`, `src/jev/**` and all of `src/loop/**`, `src/orchestrate/**`, `src/coordination/**`, `src/import/**`,
`src/models/**`, `src/provider/**` (other than the eight TUI-owned shadow tables of §6.3) are **read-only this round**
— every change round 5 needs in them is a numbered REQUEST in §8.2.

### 0.1 Owner ratification (filled in 2026-09-22 by the TUI session owner; every row follows §0 as amended by §0.2 unless it says otherwise)

| Decision | Owner's word |
| --- | --- |
| D-AC | **(b)** — `/peers` stays exactly TD4 §7.10 (count + coarse state; its per-peer rows are superseded, see Q19: confirmed as a doc fix); `/who` is the full `SessionActivity` verb. |
| D-AD | **(b)** — `LedgerHandle` everywhere; `resumeRun` calls `claimRefusal` itself before `createEngine`. Swap to the peer's alias by find-and-replace when W2b exports it (Q1). |
| D-AE | **(b)** — `[now]` + the coordination target forms now; `tree` / `agent:<slug>` as one documented additive union branch, parsed but refused with the §12 string until the agent tree has a referent. |
| D-AF | **(a), SETTLED with the peer 2026-09-22** — the harness W2b agent adds `'lease-conflict'` **and** `'land-preflight'` to `BlockingKind` together with placeholder case lines in the four TUI consumers (`blocking/lines.ts` ×2, `status/lines.ts:284`, `pane/blocking.test.ts:58`) in one commit; round 5 builds the pane and restyles both labels. Q8 is therefore answered. |
| D-AG | **(a) as amended by §0.2** — two rungs (`ctx 41%` at ≥ 80 columns, full form at ≥ 100), the amber/red **word replaces** the cell, the crossing set is per process and re-announced on resume, R13 stands. |
| D-AH | **(c)** — join `status().context`, `snapshotState()` and `readContextSummary()`; `/context drop` and `/keep` stay out of scope. **Plus §0.3 item 2:** the memory row from `formatMemory(status.context.memory)` (contract 1.6). |
| D-AI | **(b)** — the whole chain: rows, `ResolvedConfig.context()` implemented for real, and `contextPolicy` passed at every `createEngine` call site; the false doc comment on `context?()` is corrected in the same commit. |
| D-AJ | **(b)** — keep the as-built compaction line; the peer corrects COORDINATION-DESIGN §8.6 (Q3). |
| D-AK | **(b)** — build the pure builders against `src/orchestrate/index.ts` today; since contract 1.5 is on main (2400a0c) the re-point to `src/core/types.ts` happens inside round 5 when the slot rebases, with no reshape. |
| D-AL | **(b)** — `/end [now]` for one run ships now on the existing `Engine.end?()`; the confirm ladder and the `session:end` index kind land with it. |
| D-AM | **(a)** — the four `ConfirmRequest` fields and the five count-preserving render branches land alone first, proven by a synthetic fixture; the agents tab consumes them in a later wave. |
| D-AN | **(b)** — every command row is registered with its honest "not available in this build" answer (the `/peers` precedent); no dead pointers, no hidden rows. |
| D-AO | **(b), simplified** — round 4 (`src/tui/block/**`) merges to main **before** round-5 implementation starts, so the import overlay and report build directly on `BlockRow`/`renderBlock`; the stub-and-swap step is dropped unless round 4 slips. |
| D-AP | **(a)** — widen `ProviderName` and `GeneratorConfig.provider` to the seven `ProviderId`s as contract 1.8 item 6 and delete the two-name check (Q9 to the peer is a confirmation only). |
| D-AQ | **(b) as amended** — a pane-slot picker (`PickerKind`/`PickerOpen`, the `/resume` precedent), not an overlay. **No `Ctrl+L` chord in round 5**: chords are scarce, `Ctrl+L` means "redraw" in most terminals, and `/model` is two keystrokes through the palette; revisit only if usage shows the need. |
| D-AR | **(b)** — the hardened wizard stays binary; the other five providers arrive through `/provider <id>` and `jevcode login --provider <id>`. Validation is the **free authenticated catalogue GET** where the provider has one, never a priced decider call unless the user asks for a probe explicitly; keys live in a **per-provider map** (one env name per provider already exists in `.env` and `src/provider/ids.ts`), never a single `apiKey` slot. |
| D-AS | **(b) as amended** — one commit by **R5-1** lands all seven `INDEX_KINDS` rows, exports the array typed `readonly IndexKind[]`, and adds the two **optional** arms (`by?`, `parentSessionId?`) with stated reader defaults. |
| D-AT | **(b)** — classify `index.lock` / `EAGAIN` / `EBUSY` in `src/workspace/**` the way `classifyDiskError` classifies disk faults and surface one named, recoverable error with a `--plain` twin; no raw git stderr reaches the user. |
| Mechanical consequences | accepted as written in §0, §8 and §9; the eight `contract 1.6 item N` comments from round 4's draft are renumbered to `1.7` in R5-2's W0 commit (§8.1 item 10). Implementation starts only after round 4 (`r4-impl`) merges to main. |

### 0.2 Recommendations the review changed (the rest are unchanged)

Seven of the eighteen recommendations were amended by the design review; none was reversed. The owner ratifies the
**amended** text in §0, not the original.

| Decision | What changed | Why | Finding |
| --- | --- | --- | --- |
| **D-AC** | the *evidence* only — the argument is now "`PeerView` carries no per-peer rows", not "growing it breaks a privacy contract" | TD4 §7.10 itself specifies a `workspace` row *and* "never a path"; the old argument rested on a misquote | #30, #52 |
| **D-AF** | `'lease-conflict'` is **not** an additive member: four TUI-owned exhaustive consumers break. R1 becomes "one harness word + four placeholder case lines, one commit", and `'land-preflight'` rides with it per `CD §F` | verified: `status/lines.ts:284`, `blocking/lines.ts:121`, `:238`, `test/unit/tui/pane/blocking.test.ts:58` | #34 |
| **D-AG** | two rungs (`ctx 41%` ≥ 80, full form ≥ 100) instead of one 100-column gate; amber/red **replace** the cell; the crossing set is **per process**, re-announced on resume; and a new REQUEST (R13) for `'llm-jev'` | requirement 3 was invisible at 80 columns and invisible in the default mode (`DEFAULT_MODE = 'llm-jev'`, `defaults.ts:50` vs `engine.ts:922`) | #4, #38, #57 |
| **D-AK** | unchanged in substance; recorded that contract 1.5 landed on `main` at `2400a0c`, so the re-point may happen inside round 5 | `CD §F` | #32 |
| **D-AP / D-AQ** | the model picker is a **pane-slot picker** (`PickerKind`/`PickerOpen` in `src/tui/Picker.tsx` + `App.tsx`), **not** an `OverlayKind`; `'models'` is deleted from §8.1 item 10's overlay list | `/resume` — the precedent D-AQ cites — is a `useReducer(pickerReducer, …)` at `App.tsx:626` rendered into the pane slot (`PICKER_PANE_WANT = 12`, `src/tui/Picker.tsx:163`), not an overlay; the two specs were incompatible | #13 |
| **D-AS** | the same commit **exports** `INDEX_KINDS` and re-types it `readonly IndexKind[]`; the two widened arms are **optional** with stated reader defaults; the owner is **R5-1** (it owns `src/session/**`), not R5-6 | the array is module-private and typed `readonly string[]`, so the test and gate the design names cannot be written | #17, #18, #55 |
| **N1** (§1.3) | the stated blockers are re-grounded: contract 1.5, P9/P10 and `StageName 'decompose'` are **on `main`**; the one remaining blocker is `src/loop/stages/decompose.ts` + its engine wiring (`CD §B` item 5) | `CD §F` | #32 |

### 0.3 Owner amendments after the fix pass (2026-09-22) — contract 1.6 on main at `1aa720e`, and three peer facts that arrived during the fix pass

The digest's §F and §G (`docs/research/tui/round-5/00-contract-digest.md`) were appended while the designer and the fix
pass were running; the items below are **binding** and override the older sentences they name. Slots apply them as
part of their W0 read.

1. **Secret question ids — REVERSED (supersedes §5's "ordinal `secret_<i>`" sentences near line 1518 and Q4 in §15).**
   Group I is content-keyed like the rest: the id is `secret_<candidateId>` and `secretId()` is exported from
   `src/import/plan.ts`; the ordinal + lookup table is gone (IMPORT-DESIGN §4.4.3 amended, §7.8 as built). Every round-5
   fixture and test that spelled `secret_0` / `secret_1` calls `secretId(...)` instead; nothing in the TUI derives an id
   by counting.
2. **`/context` gains the memory row (IMPORT §7 row 43; D-AH).** `ContextUsage.memory?: MemoryUsage { indexChars,
   rulesChars, rulesAllowanceChars, rulesMatched, rulesShown, memoryChars, memoryAllowanceChars, memoryMatched,
   memoryShown }` and `formatMemory(u)` (exported from `src/loop/context/meter.ts`) produce
   `memory 2.1k of 24k · 3 of 4 rules, 1 of 2 notes · index 512`, or `null` on a run with no memory. `/context` renders
   that string verbatim as one block row when non-null and **omits the row** (never prints `memory —`) when null; the
   `--plain` twin is the same string. The prompt shapes the row summarises are user-visible facts `/context` must be able
   to explain in its `--verbose` form: `## Memory (index)` once per run (≤ 200 lines / 8,192 chars, clips announced) and
   `## Rules in scope …` / `## Memory in scope …` per step after `kept`, with budgets clamp(10 % of budgetChars,
   2–12 KiB) and clamp(14 %, 2–16 KiB) that are **never silent when cut** — so the clip notices the engine emits are
   transcript rows with twins, pinned in §12/§13 by the slot that owns `/context` (R5-3).
3. **`EngineOptions.memory?: EngineMemoryOptions { index?, rules?, topics? }`** — supplied by the session wiring from
   `src/config/instructions.ts loadMemory` ([T] row 34, slot R5-5); the one-line `createEngine` call-site change is a
   §9.2 request to the `src/cli/session.ts` owner, landed in the same wave.
4. **`RunMeta.imports?: readonly string[]`** — `jevcode report` prints an `imports` row (source list) when present (R5-5);
   **`NoticeKind 'import'`** — a transcript notice row through `itemsFromEvent` with its `--plain` twin (R5-5);
   **`InstructionRecord.kind?/scope?`** and **`CheckpointState.kept?`** (kind `'fact' | 'file' | 'decision' | 'memory'`) —
   `/context --verbose` may list kept counts by kind (R5-3); none of these adds a first-frame read.
5. **Contract numbering as built.** Headers in `src/core/types.ts` are 1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7 — round 5's
   block is `// contract 1.8`, Fastlane's will be 1.9. §8's dependency rows that read "contract 1.5/1.6 not yet on main"
   are CLOSED; only `src/loop/stages/decompose.ts` + its engine wiring and `src/spend/meter.ts`'s `hold/release/heldUsd`
   remain outstanding on the peer side (§1.3 N1, Q7).
6. **Already landed on main before round 5, do not redo:** `sessionRemainingUsd(cap, spent, heldUsd = 0)` with
   `childCapUsd`/`followUpDecision` pass-through (5291e9b, d8490fa); `decompose:skipped` in `VERBOSE_ONLY_TYPES`
   (d8490fa); `'decompose'` in every stage table with `TIMELINE_EXCLUDED_STAGES` exported (2e20108); every run's decider
   wrapped in `createCachingDecider` from `src/jev/cache.ts` (f9d033e) — the `/jev` `cache hits N` row and the
   `jevcode report` column reading `StepRecord.jevCacheHits` are owed by the **round-4 owner's pass**, so round 5
   only extends them if they are still missing at its W0.
7. **`BlockingKind`** — see D-AF: both members and their placeholder cases arrive in one harness commit that
   `r4-impl` rebases over; round 5 restyles the labels and builds the lease-conflict pane on the real member.

---

## 1. Goals, non-goals, and the five user requirements

### 1.1 The five requirements, verbatim

These are the user's words for round 5. The section that answers each is in brackets; §7's numbered matrix proves
each one against a fault, and §10 names the test.

1. **"every session knows what the others do and never blocks"** [§2, §7 rows 1–20]
2. **"pause/resume/end trivial and exact at any point incl. across devices and after crashes"** [§2.6–§2.9, §4.5,
   §7 rows 21–34]
3. **"context relaxed like opencode with visible usage"** [§3, §7 rows 35–43] — **with one honest caveat, stated
   here rather than buried in §3.1.** The engine populates `EngineStatus.context` only when
   `contextPolicy.view === 'relaxed' && (mode === 'jev-on' || mode === 'jev-off')` (`src/loop/engine.ts:922`), and
   `jev-off` routes to a different engine class with no context bookkeeping at all (`src/cli/session.ts:777`). The
   product's **default mode is `llm-jev`** (`src/config/defaults.ts:50`, flipped 2026-09-22), which that guard
   excludes — so as the code stands, a default install sees **no `ctx` cell and an empty `/context`**. §8.2 **R13**
   asks the harness to include `'llm-jev'` in that guard (the contract's own doc comments already read as if it
   were: `types.ts:1345–1347` describes `contextText` as built "for a synthesizer that prompts the generator itself
   (llm-jev)", and `Engine.compact?`'s comment at `:1776` names only `jev-only` and `view: 'legacy'` as the no-op
   cases). **Until R13 lands, requirement 3 is delivered for `jev-on` only**, and every empty state names the way to
   see it: `/mode jev-on` (§3.2, S55).
4. **"import all memory/workflows at onboarding"** [§5, §7 rows 52–60]
5. **"every provider key selectable with search"** [§6, §7 rows 67–78]

### 1.2 Goals

- **G1 — a session is never surprised.** Every live JevCode on this workspace, this device or a paired device is
  visible from one keystroke (`/who`), one status cell (`⇄ 2 live · 1 heads-up · ✉ 1`) and one CLI verb
  (`jevcode sessions who`), with the same rows in all four twins. No poll blocks a frame; every read is off the
  already-maintained `Fold` (`src/coordination/types.ts:327–366`), never a fresh directory walk on the render path.
- **G2 — no cross-session action is ever silent and never blocks the local loop.** A remote `pause`/`end`/`steer`
  arrives as a `[session]`-labelled item and, unless the sender is a paired device the user already trusted for
  that verb, a `[y]`/`[Y]`/`[n]` row. The local run keeps running while the row is on screen.
- **G3 — pause, resume and end are one grammar and one confirm ladder** at the command line, in the TUI, across
  devices and after a crash, and each states exactly where it stopped and what `/resume` will do
  (replay the cached proposal, or start the step fresh).
- **G4 — the context is relaxed and its usage is on screen**: a `ctx N%` cell in the status line, a `/context`
  block that says where the budget went and why each file is in view, and a `/compact` that says what it folded.
- **G5 — onboarding offers to import what the user already has**, in ≤ 50 ms of probing, with a reviewable plan, a
  resumable apply, an undo, and a credential that is never applied by `--yes`.
- **G6 — every provider and every model is one search away**, painted from a zero-I/O snapshot on the first frame
  and refreshed in place, with a free key check and a named reason for every unavailable row.
- **G7 — the agent tree is a control surface, not a log**: sixteen row states, four cards, and a verb per row, all
  from one pure function with four render targets.

### 1.3 Non-goals

- **N1 — `AgentSupervisor` is not built this round** (§4.7). **Re-grounded after `CD §F` (§14.2 #32): two of its
  three stated blockers are gone.** Contract 1.5 is on `main` at `2400a0c`, which carries `StageName 'decompose'`,
  `PausePointReason 'delegate'`/`'review-needed'` (P9/P10) and `EngineOptions.{splitPolicy, orchestration, blocker,
  confirmer}`; this worktree simply predates it (`StageName` at `src/core/types.ts:243` has 8 members here,
  `PausePointReason` at `:1543` has 5). The **one** remaining blocker is harness D1's `src/loop/stages/decompose.ts`
  plus its engine wiring (`CD §B` item 5) — without it nothing constructs a manifest or arrives at P9, so a
  supervisor has no caller. Round 5 builds the whole **rendering and command** half against fixtures so the
  supervisor's author inherits a specified, tested consumer, and lands the five TUI-side to-dos `CD §F` assigns
  (§4.2, §4.5, §4.6, §2.11).
- **N2 — `/context drop <file>` and `/keep <text>` are out** (D-AH): both are engine writes with no contract member.
- **N3 — the onboarding wizard does not grow past two providers** (D-AR).
- **N4 — `CredentialsFile` is not widened to a per-provider key map** (D-AR).
- **N5 — no new `EngineEvent`.** Every new surface reads an existing event, an existing status field, or the fold.
  The amber/red context crossing is computed client-side (D-AG); §15 Q4 asks whether a `context:warn` event is
  wanted later.
- **N6 — round 5 changes no landed string.** The compaction notice keeps its as-built wording (D-AJ); every TD3/TD4
  glossary string is untouched; §12 is additive only.
- **N7 — no new runtime dependency, and nothing from the provider registry or the model catalogue on the
  first-frame/argv path** beyond `src/provider/ids.ts` (54 lines, zero imports, its own docblock states the rule)
  and `allStaticModels()` (`src/models/static.ts:220`, **zero imports, zero I/O**). §6.2 corrects an error the
  review caught: `instantCatalogue()` lives at `src/models/list.ts:284`, and `list.ts:16–25` statically imports
  `./http.js`, `./cache.js`, `./parse.js`, `./providers.js` and `../provider/sse.js`, so naming it as the
  first-frame exception contradicts the rule it is an exception to (§14.2 #35).
- **N8 — no *new* coordination surface is fixture-only.** The review found §2 specified only the read half
  (§14.2 #3); §2.14 adds the write half (heartbeat, claim, lease) so requirement 1 is reachable end to end in a real
  install, not just under fixtures. Nothing in §2 is deferred to round 6 except the `lease-conflict` pane's
  dependency (D-AF).
- **N9 — round 5 adds no *static* import of `src/coordination/**`, `src/models/**`, `src/import/**` or
  `src/orchestrate/**` to any module reachable from `src/cli/main.tsx`'s argv path.** Values enter behind
  `await import()`; types enter as `import type` only. §6.2 states the rule once; gate G-R5-1 asserts it.

### 1.4 What "never blocks" means precisely

Three separate promises, each with its own gate (§11):

1. **The fold never blocks a frame.** `LedgerHandle.open()` is called **after** `renderer.firstFrame()`
   (CO §3.5's own rule, restated at `src/coordination/types.ts:470`'s doc comment); before it resolves every
   coordination surface reads an empty fold and renders its own empty state, never a spinner in the status line.
2. **A peer never blocks this run.** No coordination read is on the step path this round: the engine is not given a
   ledger (D-AD), so nothing a peer does can stall a local step. A `lease-conflict` pane, when it lands (D-AF), is
   the single exception and is a *pane* — the user answers it, and `[w] wait` is explicit.
3. **A blocked peer is visible, not invisible.** Any row whose liveness is `stale`/`gone`/`hung` says so in words
   (`◌ stale (last beat 4 m ago)`, `● … (no beat 4 m — hung?)`), never by being absent.

---

## 2. The coordination surface — "every session knows what the others do and never blocks"

### 2.0 The starting position, measured

The harness half is substantially built and wired into nothing. Verified in this worktree, 2026-09-22:

| Built | Where | Consumers under `src/tui/**` / `src/cli/**` / `src/session/**` |
| --- | --- | --- |
| `Fold`, 14 fields (`live, gone, leases, byPath, inbox, acks, devices, cloned, liveness, ignored, skipped, at, forks?, origins`) | `src/coordination/types.ts:327–366` | **none** |
| `Ledger` (7 members) / `LedgerHandle extends Ledger` | `types.ts:466–485` / `src/coordination/ledger.ts:189`; `openLedger()` returns the handle, `ledger.ts:1774` | **none** |
| `SessionActivity` (18 fields incl. `flags` × 8, `heartbeat`, `leases`, `authority`, `syncLagMs`) | `types.ts:434–458` | **none** |
| `listSessions(fold, self, {all?})` | `src/coordination/fold.ts:387` | **none** |
| `claimRefusal(local, foreign)` | `src/coordination/claims.ts:265` | **none** |
| `ForkVerdict` / `ForkRole` / `forkVerdict` / `unverifiedFork` | `claims.ts:220`, `:222`, `:246`, `:252` | **none** |
| `compareClaim` (epoch desc → deviceId asc → runId asc → at asc → pid asc) | `claims.ts:85` | **none** |
| `lockReplaceVerdict({lock, peerLive, self})` | `src/coordination/records.ts:829` | **none** |
| `isLive(record, now, arrival, env, origin)` — 5 params, 4th is `env` | `records.ts:714` | **none** |
| `Engine.pause(opts?)` / `end?(opts?)` / `deliver?(msg)` | `src/core/types.ts:1769` / `:1771` / `:1773` | `pause` only, no `opts` |
| `PauseOptions.by: 'self' \| \`peer:${string}\` \| \`device:${string}\`` | `:1582` via `PausePoint['by']` `:1576` | never passed |
| `BlockingAnswer` already has `'wait'` and `'worktree'`, comment naming the lease-conflict pane | `:1226` | unreachable — no `BlockingKind` member |

Not built, verified by absence: `BlockingKind` has no `'lease-conflict'` (`:1225`); `UiLabel` has no `'[session]'`
(`:1461`, 6 members); `SessionRow` has no `ended?`/`parentSessionId`/`workspaces?` (`:1923`); `INDEX_KINDS` has 8
kinds (`src/session/index.ts:36`); `src/cli/sessions.ts:122`'s dispatcher has `list | reindex | prune | unlock` and
nothing else; `src/tui/commands/registry.ts` has no `who`/`inbox`/`tell`/`headsup`/`request`/`end`/`peers` row;
`src/config/types.ts:6–63` has no `coordination.*` setting; the pause index line (`src/cli/session.ts:1550`) carries
no `by`; `src/chat/facts.ts:17` has 14 `FactKey`s and none of them is "who else is working here".

### 2.1 One facade, one type, one open

**Rule 1.** `src/coordination/index.ts` is the only import path. No TUI-owned file imports
`src/coordination/{ledger,fold,claims,records,leases,mailbox}.js` directly.

**Rule 2 (D-AD).** Every coordination-typed variable is `LedgerHandle`, never the bare `Ledger`. The bare interface
cannot call `status()`, `forkVerdict()`, `setDeviceLabel()` or `syncStatus()`, and `openLedger()` — the only
constructor the TUI will ever call — returns the handle (`ledger.ts:1774`). If the peer later exports `Ledger` as an
alias of `LedgerHandle` (`CD §E` item 3), the alias is a rename with no call-site change.

**Rule 3.** Exactly one `LedgerHandle` per process, created by `src/cli/session.ts` and passed down; `open()` is
awaited **after** `renderer.firstFrame()`, never before (the first-frame gate, §11). Before `open()` resolves the
fold is empty and every surface renders its empty state.

**Rule 3a (new, §14.2 #35 — without it gate G-R5-1 cannot pass).** `src/cli/main.tsx:31` **statically** imports
`./session.js`, so the moment `src/cli/session.ts` carries a top-level `import { openLedger } from
'../coordination/index.js'` the whole ledger/fold/claims/records/leases/mailbox tree is on the argv path.
`src/coordination/**` therefore enters **only** through `await import('../coordination/index.js')`, inside the same
post-`firstFrame()` async step that awaits `open()` — exactly the shape `defaultEngineFactory` already uses for the
engine (`src/cli/session.ts:776–778`, "both dynamic imports: the first frame never pays for them"). Every
coordination **type** (`LedgerHandle`, `Fold`, `SessionActivity`, `SelfIdentity`, `Liveness`) is reached with
`import type`, which erases. The same rule covers `src/import/**` (§5.1's `probe()`), `src/models/**` (§6.2) and
`src/orchestrate/**` (§4.1). Gate **G-R5-1** asserts the import graph.

**Rule 6 (new).** No TUI-owned module reachable from the first frame holds a **value** from a peer tree. Where a
value is wanted — `DEFAULT_SPLIT_POLICY` (`src/orchestrate/index.ts:47`), an `AgentState` word table, a base URL —
it is either re-declared TUI-side against the peer's type (so `tsc` catches drift) or reached behind
`await import()`. `src/orchestrate/index.ts` is a **value** module: it re-exports `readManifest`/`writeManifest`
(`:108`) and `dirtySnapshot` (`:114`), whose own dependencies import `node:fs/promises`
(`src/orchestrate/worktree.ts:29`, `land.ts:40`, `manifest.ts:22`).

**Rule 4.** The TUI never re-derives "is this mine?" from a record field. `Fold.origins` is the only answer;
`SessionActivity.sameDevice` (`types.ts:440`) and `authority` (`:444`) are what the renderer reads. A check of the
form `record.deviceId === self.deviceId` reintroduces the forged-record hole CO's revisions 4/5 closed (§7 row 17).

**Rule 5.** `role === 'loser'` alone is never a stop. The gate is `role === 'loser' && verified === true`
(`claims.ts:251`); `unverifiedFork` (`:252`) raises a flag and a `[c]`/`[q]` row and **never** an unprompted stop
(§7 row 16).

### 2.2 The status zone: `⇄ 2 live · 1 heads-up · ✉ 1`

A new right-zone segment `'peers'` joins `SegmentId` (`src/tui/status/lines.ts:401`) and `DROP_ORDER` (`:413`).

- **Content.** `⇄ <n> live` when `n ≥ 1`; ` · <m> heads-up` when unread heads-up messages exist; ` · ✉ <k>` when
  the inbox has `k` unread directed messages. Absent entirely when all three are zero — never `⇄ 0 live`.
- **Source.** `fold.liveness`, `fold.inbox`, `fold.acks` through one pure `peerZoneText(fold, self, g)` in
  `src/tui/status/lines.ts`. No I/O; the fold is already maintained by its watcher.
- **Drop order, and the round-4 rule it amends.** `'peers'` is inserted **after `'ctx'` and before `'sess'`**:
  session money outranks it; git state, the sparkline and the context cell do not. The single `DROP_ORDER` edit,
  landed once by R5-2 on behalf of all three new segments, is
  **`['help', 'spark', 'git', 'ctx', 'peers', 'sess', 'wall']`** — seven entries, quoted identically in §3.1, §8.1
  item 10 and §9.2 (`src/tui/status/lines.ts:413`, five entries today). **This amends TD4 §7.10 edge (2)**
  ("the segment is the **first** thing dropped", `docs/TUI-DESIGN-4.md:2826`): TD4's segment was a bare `<n> here`
  count, whereas round 5's carries **unread-message counts**, and an unread directed message outranks git state —
  a user who loses `⇄`/`✉` at 100 columns loses the only signal that someone is waiting on them. §0's preamble
  records the amendment.
- **Display position.** `rightZoneSegments` (`src/tui/status/lines.ts:450`) pushes in a fixed order and the drop
  loop works off `DROP_ORDER`, not the push order, so the two are specified separately. The push order becomes:
  `step` → `run` → **`agents`** → `sess` → `tokens` → **`ctx`** → **`peers`** → `git` → `spark` → `help` →
  `secret`. Agents sit beside `run` because they spend the run's money; `ctx` and `peers` sit after `tokens`
  because they are run facts, not workspace facts. **F-51 and F-55 are corrected to this one order** (§2.12, §4.11).
- **Three rungs, not one gate.** `PEERS_MIN_COLUMNS = 80` gates the segment as a whole; inside it,
  `peerZoneText(fold, self, g, columns)` drops **right to left** in one stated order, the same way `gitZoneText`
  already does: at ≥ 100 columns the whole `⇄ 2 live · 1 heads-up · ✉ 1`; at ≥ 80 the heads-up clause drops
  (`⇄ 2 live · ✉ 1`); below 80 the segment is absent. `HEADSUP_MIN_COLUMNS = 100` is the named constant, and §10's
  `status/lines.test.ts` asserts the clause drop at 79/80/99/100 (§14.2 #28).
- **Glyphs.** `⇄` → `<>` and `✉` → `mail` under `--ascii`, through `GLYPHS`/`glyphSet({ ascii })`
  (`src/tui/glyphs.ts:213`, `:216`) — **`glyphSet` takes an options object, not a boolean**
  (`glyphSet(opts: { ascii?: boolean; screenReader?: boolean } = {})`, `:216`), and `ascii` wins over
  `screenReader` per its own doc comment, so the SR twin of an `--ascii` run is the ASCII set (§14.2 #53). Never a
  literal in `status/lines.ts` (§7 row 40 is the same defect for `·`). Both `⇄` and `✉` are **new `GlyphSet`
  members** — see §8.1 item 10's nine-glyph list.
- **Screen reader.** The status line is never read live (TD4 §5.8's rule); a *change* from 0 → ≥ 1 unread announces
  once: `1 message from mbp — /inbox reads it`.

### 2.3 `/who` and `jevcode sessions who` — the full activity view

One pure builder, four render targets, per TD4 §3.1's grammar (D-AO applies here too: the rows are `BlockRow[]`).

```
whoRows(rows: readonly SessionActivityView[], self: SelfIdentityView, opts: { all?: boolean; width: number; g: GlyphSet }): BlockRow[]
```

**One row model, not two (§14.2 #12).** The builder, the `SessionHost.who?()` host method (§8.1 item 4), the Ink
tab, the `--plain` twin, the screen-reader twin and `sessions who --json` all take **`SessionActivityView`** — the
TUI-facing projection — so "one pure builder, four render targets" is provable rather than asserted. The
`SessionActivity → SessionActivityView` and `SelfIdentity → SelfIdentityView` **mappers live in
`src/session/peers.ts`** (R5-1, beside `peerViewOf`) with their own table test over the same 12 fold fixtures; they
are the **only** place `src/coordination/types.js` is read outside `src/cli/session.ts`. An earlier draft had
`whoRows` take coordination's `SessionActivity` while the host method and the `--json` shape took the view; that
made the invariant unprovable and leaked `SelfIdentity` (which carries `hostKey`) into a JSON contract the view
exists to keep clean.

**Row shapes (CO §3.6, verbatim; §12 carries the twins).** The renderer branches on
`SessionActivity.kind` (`src/coordination/types.ts:441`) — a `bench` heartbeat is a **different row**, not a variant:

```
● mbp  main@3f9a2c1  step 7/40 propose  jev+llm  ctx 41%  $0.12/2.00  editing src/loop/engine.ts (+1)  lanes 2 · samples 3  beat 2 s
● mbp  bench glm-vs-jev  12/30 tasks live 4 · lanes 8
◌ stale (last beat 4 m ago) · crashed during step 8 (propose)
● … (no beat 4 m — hung?)
? unknown (not synced yet)
```

**Flags.** `SessionActivity.flags` has eight booleans (`hung, skewed, forked, takenOver, noLock, ignoredDevice,
unverified, cloned`, `types.ts:443`). Each appends one dim suffix in a fixed order —
`⚠ hung · ⚠ skewed <n>s · ⚠ forked · taken over · no lock · ignored · unverified · ⚠ cloned` — and a flagged row is
**never hidden**: a cloned device's row shows, flagged and with its gated actions disabled, because hiding it hides
the information needed to fix it (§7 row 13).

**Width behaviour.** The row is built as a `table` `BlockRow` whose columns drop right-to-left as `blockWidth`
shrinks: `lanes · samples` → `editing …` → `$spend` → `ctx` → `mode` → `branch@sha`. At 40 columns a row is
`● mbp  step 7/40 propose  beat 2 s`; at 80 it drops `lanes · samples`; at 120 it is whole. The identity rule holds:
`--plain` prints the same row the TUI drew at the same width (§13).

**Arguments.** `/who` (live + gone within 10 min) · `/who --all` (adds stale > 10 min and ignored-device rows, the
`opts.all` branch of `listSessions`, `fold.ts:387`) · `/who <target>` (one row, expanded to a card).
`availableDuringTask: 'any'`, `category: 'session'`, `plain: 'yes'`.

**CLI twin.** `jevcode sessions who [--all] [--json]`. `--json` emits `{ "sessions": SessionActivityView[],
"self": SelfIdentityView, "at": string }` — the **view** objects as-is, mirroring `sessions list --json`'s
`{ sessions, skipped }` shape (`src/cli/sessions.ts`), never a second hand-shaped row model and never a row string.
`SelfIdentityView` is `{ deviceId8: string; label: string; sameDeviceCount: number }` — **`SelfIdentity`
(`src/coordination/types.ts:369`) carries `hostKey`, a device secret derivative, and must never reach a JSON sink**
(§7 row 61).

**Empty state.** `no other jevcode is working here — /who --all includes sessions gone more than 10 minutes`.

### 2.4 `/peers` — round 4's stub, wired

**Which half of TD4 §7.10 survives, stated plainly (§14.2 #10, #52).** `/peers` keeps TD4's **head, empty state,
stub state and blocking row, verbatim** — head `peers · <n> here, <m> stale`; empty
`no other jevcode is working in this workspace`; no registry `the peer registry is not available in this build`;
the blocking row `[w] wait for it   [r] read-only session   [q] quit`. Two TD4 clauses are **superseded, not kept**:
(i) the **per-peer kv rows** (`workspace`, `started <t> ago`, `<state>`, `docs/TUI-DESIGN-4.md:2816–2817`) — which
`PeerView`'s four scalars (`src/core/types.ts:1904–1909`) cannot produce, and which TD4 itself contradicts two
clauses later with "never a path" — are **`/who`'s job now** (§2.3); and (ii) the status segment is no longer the
bare `<n> here`, it is `⇄ <n> live · <m> heads-up · ✉ <k>` (§2.2), because it now carries message counts. §12.1's
"kept from TD4 §12" list records exactly which strings survive. Round 5 otherwise changes only **where the numbers
come from**: a new `peerViewOf(fold, self): PeerView` in
`src/session/peers.ts` (new, TUI-owned) folds `fold.liveness`, `fold.leases` and `fold.origins` into the four
existing fields, and `SessionHost.peers?()` (`src/core/types.ts:1901`) returns it instead of `null`.

**The privacy contract is load-bearing and unchanged:** `PeerView` is a count, a count, an age and a boolean
(`:1904–1909`). No pid, no path, no device label. A user who wants detail types `/who`. `/peers`' own help title
gains ` · /who shows what each is doing` so the narrow view is never a dead end.

### 2.5 The target grammar — one resolver, one test

`src/tui/commands/target.ts` (**new**, TUI-owned, zero I/O, pure) is the single implementation, shared by every
slash command and by `src/cli/sessions.ts`:

```ts
export type Target =
  | { kind: 'self' }
  | { kind: 'run'; runId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'title'; title: string }
  | { kind: 'device'; label: string }
  | { kind: 'all' };
/** contract 1.8 note: orchestration's `tree` / `agents` / `agent:<slug>` are additive members of this union (D-AE). */

/** §14.2 #missing: the three outcomes, spelled out — `sessions who|pause|end <target>` all serialise them. */
export type Candidate = { readonly id8: string; readonly title60: string; readonly label: string };
export type Resolved  = { readonly kind: 'resolved'; readonly target: Target; readonly matchedBy: 'runId' | 'sessionId' | 'idPrefix' | 'device' | 'title' | 'titlePrefix' | 'reserved'; readonly id8: string | null };
export type Ambiguous = { readonly kind: 'ambiguous'; readonly text: string; readonly candidates: readonly Candidate[]; readonly truncated: boolean; readonly message: string };
export type NotFound  = { readonly kind: 'notFound'; readonly text: string; readonly message: string };
export type TargetResult = Resolved | Ambiguous | NotFound;

export function resolveTarget(text: string, fold: Fold, self: SelfIdentityView): TargetResult;
```

`candidates` is capped at **five** with `truncated: true` beyond that; `message` is the already-built sentence
(S43/S44) so the CLI, the dispatcher and `--json` cannot each write their own. Every `sessions <verb> <target>
--json` that refuses emits `{ ok: false, reason: 'ambiguous' | 'notFound', candidates?, message }` — the
`TargetResult` fields, never a re-modelled shape.

**Resolution order, stated once** (CO §5.3): exact run id → exact session id → unique id prefix (≥ 8 chars) →
`device:<label>` → exact title → unique title prefix. **A title equal to a reserved word (`all`, `self`, and later
`tree`/`agents`) is addressable only by id** — the reserved word always wins, and the ambiguity message says so:
`"all" is a reserved target — the session titled "all" is <id8>`. An ambiguous prefix lists up to five candidates
and refuses. `resolveTarget` takes a `Fold` as a plain argument, never a `LedgerHandle`, so it is a pure function
with a table-driven test (`sessions-target.test.ts`, §10).

### 2.6 `/pause` widened

Today `/pause` is a registry row with no args, `live`-only, title "stop after the step in flight commits", and
`CommandAction` `{ kind: 'pause' }` carries no payload (`src/tui/commands/dispatch.ts:45`). Round 5 widens it to
`/pause [now] [<target>]`.

**Availability moves to `'any'`, with a hand-written refusal for the local form only (§14.2 #16, #39).** Left at
`availableDuringTask: 'live'`, `availabilityError` (`src/tui/commands/registry.ts:601`) answers
`error: /pause needs a live run` for `/pause mbp` — a verb that touches no local engine at all, sent from an idle
TUI, which is the ordinary case. So `/pause` and `/end` both take `availableDuringTask: 'any'` and the dispatcher
refuses **per form**: with no target and no live run, `/pause` answers
`/pause with no target needs a live run — /pause <target> asks a peer, any time` (S45a); `/end` with no target and
no live run answers `nothing is running to end — /end <target> ends a peer's run, jevcode sessions end <id> ends
one from the shell` (S45b). Both are §12 strings, not generated text — the generated `availabilityError` cannot
express a per-form rule. §4.9's table and §9.2's `registry.ts` row carry the `'any'` value.

| Form | Effect | Landed contract member |
| --- | --- | --- |
| `/pause` | `engine.pause({ at: 'step', by: 'self' })` | `PauseOptions.at` (`types.ts:1583`) |
| `/pause now` | `engine.pause({ at: 'now', by: 'self' })` | same |
| `/pause <target>` | a `pause` message to the target's inbox, `by: \`device:${id8}\`` at the far end | `PausePoint['by']` (`:1576`), `Engine.deliver?` (`:1773`) |
| `/pause all` | the local run, then one message per live foreign row of `listSessions` | — |

**The status strings are CO §7.6's, verbatim** (§12): `pausing · step 8 commits first (propose, 41 s, ~40 s p50
left) · Esc Esc aborts · Ctrl-X Ctrl-P pauses now` · `paused now at step 8 (propose): proposal kept — /resume
replays it` · `paused after step 7 — /resume continues, or type a follow-up` · `paused at the <kind> pane after step
7 — /resume retries it`. The "wait, never kill" rule for P4/P5 is a string, not a code path:
`pausing · execute finishes first (12 s)`.

**The pause index line gains `by` — optional, with a stated reader default (§14.2 #17).**
`src/cli/session.ts:1550` writes `{ v:1, t, kind:'pause', sessionId, runId, step }`; round 5 adds
**`by?: 'self' | \`peer:${string}\` | \`device:${string}\``** to that `IndexLine` arm (`src/session/index.ts:30`) so
a later `/who`/`sessions list` can say who asked. **The `?` is load-bearing**: the arms at `src/session/index.ts:24–34`
are all-required object literals and every `pause` line already on disk was written without the field, so a
required `by` would fail the arm's shape for every historical session and change the fold's behaviour for existing
installs. **The reader defaults `by ?? 'self'`** (a line written before this round was necessarily written by the
local session) and `parentSessionId ?? null` on `run:start`. §10's `session/index.test.ts` folds a pre-round-5
`pause` line with no `by` and asserts the default. This is a TUI-owned file and rides the one `INDEX_KINDS` commit
(D-AS), which also exports the array.

### 2.7 `/end`

`/end [now] [<target>]`, **`availableDuringTask: 'any'`** (§2.6), calling the **already-existing**
`Engine.end?(opts?: EndOptions)` (`src/core/types.ts:1771`) — D-AL. **What `/end` ends when no run is live
(§14.2 #39):** it ends the **session**, not a run — it writes `RunMeta.ended` against the session's most recent
run and one `session:end` index line, so `/resume <id>` afterwards needs `--force`. S28's `after step 7` therefore
reads the last committed step of that run; with no run at all in the session the answer is
`nothing is running to end — /end <target> ends a peer's run, jevcode sessions end <id> ends one from the shell`
(S45b) and nothing is written. Because `end` is irreversible for the session (a `/resume` afterwards needs
`--force`), it takes the confirm ladder, through `fitRung` (TD4 §2.6):

```
end this session: [y] at step boundary  [Y] now  [n] stay
end session: [y] at step end  [Y] now  [n] stay
end: [y] step end  [Y] now  [n] stay
y end · Y now · n stay
```

Enter on this row is **inert** (TD4 D-X §4.5's rule — `/end` joins `CommandSpec.destructive: true`). After the run
ends: `ended session "<title>" after step 7 — /resume <id> --force reopens`, and one `session:end` index line.
**Idempotency:** `end` after `pause` writes `RunMeta.ended` and leaves the pause point; `pause` after `end` answers
`already ending — /resume <id> --force reopens it`.

### 2.8 `/resume` — the claim fence and the card

**The fence (D-AD).** `resumeRun` (`src/cli/session.ts:2296`) gains one step in its existing pre-`createEngine`
sequence, between the foreign-liveness check and the HEAD-drift check:

```ts
const refusal = claimRefusal(readClaimEpochs(runId), foreignClaimsOf(fold, runId));   // claims.ts:265
if (refusal !== null && !force) { … refuse … }                                        // qualified epochs only
```

`claimRefusal` skips unqualified epochs entirely (`claims.ts:274`) and drops epochs outside
`[FIRST_EPOCH, MAX_CLAIM_EPOCH]` (`:275`), so an unverified or planted claim **annotates the card and never
refuses**. Three outcomes, three strings:

- refused: `taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it`
- unqualified: `mbp claims 4 (unverified) — ignored; sessions pair to make it count` (card line only)
- ceiling: `claim epochs for this run reached the bound (1e9); nothing can take it over — start a new run from
  this state`

**The card (CO §7.3 step 2, verbatim).** `src/session/picker-lines.ts` today measures and filters on the local index
plus a caller-supplied `live?: (runId) => boolean` (`:1–33`) and reads no fold. Round 5 threads a `Fold` in and adds
the card:

```
─ resume 20260921-234432-rpywkq2v · "fix store rotation" ──────────────────────────────
paused 42 m ago · now at step 7 (pause now during propose, 62 % streamed) · 3 steers pending
HEAD 3f9a2c1 → 8bc0d11 (2 commits by mbp: "fix store rotation", "tests") · changed since: store.ts, engine.ts
live on this repo: mbp (step 12, editing src/tui/App.tsx) · spend $0.42/2.00 · wall 12m04s/30m · ctx 41%
[Enter] resume (fresh step 7)   [r] replay the paused proposal   [f] fresh   [d] diff since pause   [w] who   [Esc]
```

**The four card keys are scoped to the card, not to the picker list (§14.2 #40).** The picker's composer **is** its
filter (`src/session/picker-lines.ts:1–33`) and picker-context bindings outrank it
(`src/tui/keys/resolve.ts:5`, "Minsize · Overlay · Picker · Composer · Global"; `picker:delete` already consumes a
bare `x`, `src/tui/keys/bindings.ts:136`). Binding `r`/`f`/`d`/`w` at picker scope would take four more letters away
from filter typing — and `w` is already a chord-first key elsewhere (`resolve.ts:62`). So the expanded card is its
own **focused sub-state**: `PickerState` gains `card: { runId } | null`, Enter on a row opens it, Esc closes it back
to the list, and the four letters resolve **only while `card !== null`** (the filter is inert in that sub-state and
the card says so: `Esc returns to the list`). Four new `PickerOp` members join the closed union at
`src/tui/keys/resolve.ts:169` — `'cardReplay' | 'cardFresh' | 'cardDiff' | 'cardWho'` — plus `'cardOpen'` /
`'cardClose'`; `src/tui/keys/resolve.ts` and the picker block of `src/tui/keys/bindings.ts` are owned by **R5-4**
with R5-1's rows landed as a §9.2 request. §7 row 91 covers "a letter typed while the card is open".

**Branches.** `[r]` appears only when `PausePoint.replayable === true` **and** every `targetsSha` still matches
(`types.ts:1566`'s own definition); otherwise `targets changed since the proposal (store.ts by mbp@8bc0d11) —
replay unavailable`. Imported run: `the paused proposal and its samples stayed on <label> — resuming starts a fresh
step`. Crashed: `crashed 3 m ago during step 8 (propose, 41 s in) — step 8 restarts`. Live elsewhere:
`● live on mbp — [w] watch (read-only tail) · [t] tell · [p] ask to pause · [Esc]`.

**The `ctx` cell on the card.** Built from `CheckpointState.lastPromptChars?` alone and **omitted, not zeroed**,
when absent. This is deliberately different from the live status cell, which shows `ctx 0%` before the first prompt:
a live `ctx 0%` is informative, a resumed `ctx 0%` before any read is a lie (§7 row 38).

### 2.9 Messaging — `/tell`, `/headsup`, `/request`, `/inbox`

Four verbs over `src/coordination/index.ts`'s mailbox API and `Engine.deliver?(msg): AckOutcome`
(`src/core/types.ts:1773`, `AckOutcome` `:1623`, `DeliverableMessage` `:1630`).

| Verb | Form | What it writes | What the far end shows |
| --- | --- | --- | --- |
| `/tell` | `/tell <target> <text>` | a directed message | `[session] mbp: <text>` |
| `/headsup` | `/headsup <text>` | a broadcast to every live row on this repo | `heads-up: editing src/loop/engine.ts (+1) for: <task60>` |
| `/request` | `/request <target> pause\|end\|steer <text>` | a gated verb request | `mbp asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore` |
| `/inbox` | `/inbox [--all]` | nothing; reads `fold.inbox`/`fold.acks` | a block of unread rows, newest first |

**`UiLabel` gains `'[session]'`** (§8 item 2). Every *applied* remote verb writes one transcript item with that
label, so `transcript.log` records who changed this run and when — a session that was paused by a peer and later
audited must not look like a local pause.

**The two gates that are not negotiable.** (1) "Same device" means the **read location** (`ctx.origin === 'local'`
via `Fold.origins`), never a content comparison — a forged file in the local subtree still has to pass the
`hostKey`/`bootId` checks before it auto-applies (§7 row 17). (2) A **cloned** device (`Fold.cloned`) has every
gated verb suspended until re-paired; its rows still render, flagged `⚠ cloned`, with the keys disabled and a reason
(§7 row 13).

**Secrets in message bodies — the one new path that writes user-typed text into a folder another device reads
(§14.2 #47).** `/tell <target> <text>`, `/headsup <text>` and `/request <target> steer <text>` all take free text
from the composer as a **command argument**, which the composer's own secret gate
(`src/tui/secrets/gate-lines.ts`) does not see — it gates submissions, not slash-command arguments. Three rules,
each with a §7 row (92–94) and a §12 string:

1. **Gated before the write.** A body that `detectSecrets` flags is held behind the same `[y]` ladder the composer
   uses: `that message looks like it contains a key — [y] send anyway  [n] edit  [Esc] cancel` (S34a). Nothing is
   written to the mailbox until the answer.
2. **Written through the run's redactor.** The mailbox record's body goes through `createRedactor(<configured
   secrets>).redact` (`src/core/redact.ts:93`) regardless of the answer, so `[y] send anyway` sends the redacted
   text, never the raw key. `FORMAT_PATTERNS` (`:68–75`) is **six** families today (OpenRouter, Anthropic, generic
   `sk-`, Google, and two GitHub) — no xAI, Fireworks or Meta (§8.2 R8), so rule 3 is the backstop, not rule 2.
3. **Redacted again on arrival, before `Engine.deliver`.** A remote `steer` body is a foreign string; it is
   redacted by the receiving session's own redactor before it reaches `Engine.deliver?(msg)`
   (`src/core/types.ts:1773`) and before it reaches `transcript.log`. A sender's configured secrets are not the
   receiver's, so the receiving end cannot rely on the sending end having redacted.

**Toast rules.** A `headsup` from a paired device is a toast; a `tell` is a toast plus an `✉` count; a `request` is
never a toast — it is a persistent row, because it needs an answer. An unpaired sender's message is rendered with
`(unverified)` and never auto-applies.

### 2.10 The `jevcode sessions` verb surface

`src/cli/sessions.ts:122`'s dispatcher grows from 4 to 17 verbs, each a thin wrapper over
`src/coordination/index.ts`'s existing write API, each with a `--json` shape, each starting no engine:

`list` · `reindex` · `prune` · `unlock` (today) · **`who`** · **`pause`** · **`resume`** · **`end`** · **`tell`** ·
**`headsup`** · **`request`** · **`inbox`** · **`label`** · **`pair`** [`--rotate`] · **`unpair`** · **`gc`**
[`--device <label>`] · **`sync status|disable`**.

Two implementation notes that are easy to get wrong:

- **`gc --device <label>` must not resolve the label through `fold.devices`.** The fold caps at `MAX_DEVICES` (16)
  subtrees; `gc`'s own label resolution walks the disk to `MAX_GC_DEVICES` (1,024) **specifically so the junk past
  the fold cap can be named and removed**. Resolving through the fold cannot reach the case the verb exists for
  (§7 row 14).
- **`unlock`'s explanation must use `lockReplaceVerdict`'s vocabulary — and only three of the six reasons carry a
  `detail60` (§14.2 #26).** `LockReplace` (`src/coordination/records.ts:807–809`; `lockReplaceVerdict` itself is at
  `:829`) is
  `{ replace: true; reason: 'no-lock' | 'dead-pid' | 'other-boot' } | { replace: false; reason: 'peer-live' |
  'boot-unknown' | 'held'; detail60: string }` — **`detail60` exists on the refusing arm only** (verified at
  `records.ts:835`, `:838`, `:839`: the three replaceable returns carry no detail). So `sessions unlock --json`'s
  `detail60?` being absent is a **documented state, not a blank cell**, and the CLI supplies its own sentence for
  the three replaceable reasons, pinned in §12 as S38a: `no lock file — taking it` · `the lock's pid is gone —
  taking it` · `the lock is from another boot — taking it`. Today `src/session/lock.ts`'s own older
  `lockIsLive(lock, {host, isAlive})` (`:57`) consults neither `peerLive` nor `bootId`. Wiring the *decision* is
  harness work (§8 REQUEST R6); wiring the *explanation* is round 5's, and the CLI must print the same six reasons
  so the text and the engine's decision cannot drift.

Pinned CLI strings (§12 carries the twins): `unpaired mbp — it can no longer steer, stop, resume, end or import
your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.` ·
`this device took a new id (<id8>) and a new key — run 'jevcode sessions pair' with each peer again` ·
`device id <id8> is also live on another machine — run 'jevcode sessions pair --rotate' to invalidate the shared
key` · `machine id unavailable — two machines sharing this home would share one device id`.

### 2.11 The `lease-conflict` pane (gated on D-AF)

If `BlockingKind` gains `'lease-conflict'` in wave 0 (§8 REQUEST R1), `src/tui/blocking/lines.ts` gains one card,
through `fitRung`:

```
another session holds src/loop/engine.ts (mbp, step 12, 3 m)
[w] wait for it   [r] read-only session   [t] relocate to a worktree   [q] quit
```

`[w]` → `BlockingAnswer 'wait'`; `[t]` → `'worktree'`, which stops the run resumably with
`PausePointReason 'worktree'` (`types.ts:1548`) and `interruptedDetail.relocate` set; `[q]` → `'stop'`. **All three
answer members already exist** (`:1226`), which is why this is a one-word request. The relocation result line is
`relocated to worktree <slug> (branch jevcode/<slug>) — /worktree back merges or hands off`.

**What happens when the holder stops beating (§14.2 #48).** `[w] wait for it` with no timeout, no progress and no
escape can wait forever on a holder that is already dead — the one blocking pane round 5 adds must not be the one
place the product hangs. `Fold.leases` and `Liveness` (`src/coordination/types.ts:327–366`, `:403`) already carry
everything needed, so three rules, each a §7 row (95–97):

- **The pane re-renders on every fold change**, and `[w]` shows an elapsed counter: `[w] waiting 2m14s — Esc gives
  up`. It never re-enters a sleep it cannot be woken from.
- **A holder that turns `stale` or `stale-reused-pid` while `[w]` is armed re-renders the card**, it never silently
  proceeds: `the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit` (S39a). `[w]`'s meaning
  changes with the card, and the card says so.
- **A lease whose holder is `gone` is not a conflict at all.** The pane never opens; one `[ui]` line records it:
  `took a lease left by a session that is gone (mbp, 14:02)` (S39b). A `gone` holder is exactly the crashed case of
  §7 row 3, and prompting for it would be the "never block on a dead peer" defect §1.4 promise 3 exists to prevent.

**The `land-preflight` row is designed here too (`CD §F`).** The peer's W2b agent adds `'land-preflight'` and
`'lease-conflict'` to `BlockingKind` in **one** commit with placeholder case lines in the four TUI-owned spots; round
5 owns both rows' strings, twins and keys. `land-preflight` is `Engine.land(input, ask?)`'s `[c]/[s]/[x]` pre-flight
surfaced as a pane: `7 uncommitted files, 2 inside an agent's slice — [c] commit them  [s] stash them  [x] cancel
the land` (S39c), where `ask` absent ⇒ `[x]` (the headless default, per `CD §F`). Its `BlockingAnswer`s reuse the
landed union; no new answer member is needed.

If the request cannot land in wave 0, **both** panes defer wholesale to round 6 and nothing else in §2 changes.

### 2.12 Frames

Rows measured at the stated geometry; §11's `block-width` gate re-checks every one at 24×20 … 40×120.

**F-51. `/who` at 80×24, three live, one crashed — head and rows in one vocabulary (§14.2 #58).** The earlier
draft's head said `3 live, 1 gone` while the fourth row rendered `◌ air stale`; `Liveness` distinguishes `stale`
from `gone` (`src/coordination/types.ts:403`, five members) and §2.3 says plain `/who` shows live + gone-within-10-
minutes with `stale` only under `--all`. The head now counts what the rows show, and the stale row is moved to the
`--all` frame. Segment order is §2.2's (`step · run · sess · ctx · peers`); the `ctx` cell is absent at 80 under
its ≥ 100 rung and `peers` renders its ≥ 80 rung, so the heads-up clause is dropped.
```
──────────────────────────────────────────────────────────────────────────────
 [ui]     who · 3 live, 1 gone
          ● this  main@3f9a2c1  step 7/40 propose  jev+llm  ctx 41%  $0.12/2.00
          ● mbp   main@8bc0d11  step 12/40 execute  ctx 63%  $0.42/2.00
          ● mbp   bench glm-vs-jev  12/30 tasks live 4 · lanes 8
          ○ air   gone 6 m ago · crashed during step 8 (propose)
          /who --all includes sessions gone more than 10 minutes
──────────────────────────────────────────────────────────────────────────────
 ⏺ step 7/40 propose   run $0.12/2.00   sess $0.43/10.00   ⇄ 2 live · ✉ 1
 ›
```
**F-51a. the same fold under `/who --all` at 120 columns** — the stale row appears, the head names it, and the
`ctx` and full `peers` rungs are both in.
```
 [ui]     who · 3 live, 1 gone, 1 stale
          ◌ air   stale (last beat 4 m ago) · crashed during step 8 (propose)
 ⏺ step 7/40 propose  run $0.12/2.00  sess $0.43/10.00  ctx 41% · 6 files · 12 steps  ⇄ 2 live · 1 heads-up · ✉ 1
```

**F-52. the `/end` confirm at 80 columns (the `fitRung` rung that fits).**
```
──────────────────────────────────────────────────────────────────────────────
 end this session: [y] at step boundary  [Y] now  [n] stay
──────────────────────────────────────────────────────────────────────────────
```

**F-53. a remote pause request, 80 columns — a row, never a toast.**
```
 [session] mbp asks to pause this run — [y] pause at step end  [Y] now  [n] ignore
```

### 2.13 Behaviour at 40, 80 and 120 columns

| Surface | 40 | 80 | 120 |
| --- | --- | --- | --- |
| status peers segment | absent (`PEERS_MIN_COLUMNS = 80`) | `⇄ 2 live · ✉ 1` — the heads-up clause drops below `HEADSUP_MIN_COLUMNS = 100` (§2.2) | `⇄ 2 live · 1 heads-up · ✉ 1` |
| resume card, expanded | the card sub-state is the whole pane; keys at rung 4 | card sub-state, rung 2 | card sub-state, rung 1 |
| lease-conflict, holder stale | `w take · r read-only · q quit` | `the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit` | same |
| `/who` row | `● mbp  step 7/40 propose  beat 2 s` | drops `lanes · samples` | whole |
| resume card | keys row at rung 4 (`Enter resume · r replay · Esc`) | rung 2 | rung 1 (the five-key row) |
| `/end` confirm | `y end · Y now · n stay` | rung 1 | rung 1 |
| lease-conflict pane | `w wait · r read-only · t worktree · q quit` | full | full |

### 2.14 What this session **publishes** — the write half (§14.2 #3, N8)

Everything above is a **read**. The review found that nothing in the document started a heartbeat, minted a claim or
wrote a lease, so in a real install `Fold` would never contain this session, every §2 surface would show its empty
state forever, and requirement 1 ("every session knows what the others do") and requirement 2's cross-device
takeover would be reachable only under fixtures. `createHeartbeatWriter` / `buildHeartbeat` / `HeartbeatWriter` are
**built and exported today** (`src/coordination/index.ts:309–310`) with zero callers. Round 5 wires all three
writes. Owner: **R5-1**, in `src/cli/session.ts` (§9.2 gives R5-1 that file).

| What | Who calls it | When | The rule that makes it safe |
| --- | --- | --- | --- |
| **the heartbeat** | `src/cli/session.ts`, immediately after the `await import('../coordination/index.js')` that opens the ledger (§2.1 rule 3a) | started **after** `await ledger.open()`, which is itself after `renderer.firstFrame()`; the **first** write is therefore provably post-first-frame, and gate G-R5-1 asserts it | `createHeartbeatWriter`'s own coalescing (`HEARTBEAT_COALESCE_MS`, exported at `:309`) is the tick; the TUI never adds a `setInterval` (the `setInterval( only in spinner.ts/retry.ts` rule holds). The writer is **stopped in the same `finally` that releases the run lock**, so a clean exit leaves no beating record |
| **the claim** | `src/cli/session.ts`, at **run start and at `/resume`** — `nextEpoch` + `writeClaimsProjection` through the facade | once per run start, never per step; `/resume --force-takeback` bumps the epoch, an ordinary `/resume` of an uncontested run does **not** (§7 row 26's "zero epoch bump") | `claimRefusal(readClaimEpochs(runId), foreignClaimsOf(fold, runId))` (§2.8) is read **before** the mint, in the same pre-`createEngine` sequence; minting after a refusal would be the double-writer hole `compareClaim` exists to close |
| **leases** | `src/cli/session.ts`, per step, from the step's declared targets | written when a step declares targets, released at step commit and in the exit `finally` | a lease is **advisory** this round: it is what a *peer* reads to show `editing …` and to open the `lease-conflict` pane (§2.11). Nothing in the local loop reads a lease, so §1.4 promise 2 ("a peer never blocks this run") is unchanged |

**Three consequences the implementer must not miss.** (1) The heartbeat's `subwork` is the only source for a run
row's `lanes 2 · samples 3` cell (`src/coordination/types.ts:145`) — §8.1 item 4's view carries it explicitly.
(2) A crash leaves the last beat on disk, which is exactly what makes §7 row 3's `crashed during step 8` row
possible; the writer must therefore **never** write a "clean" terminal beat it cannot guarantee. (3) The writer is
the only thing that can put this device's own key material near a file, so §7 row 61's `assertNoKeyBytes` runs
against the beat file itself in `r5-who.steps`, not only against frames.

---

## 3. The context meter and compaction — "relaxed like opencode, with visible usage"

### 3.0 What is already built, and what round 5 actually adds

The engine-side subsystem is **finished**, further than CD credits. Verified in this worktree:

| Built | Where |
| --- | --- |
| `EngineStatus.context?: ContextUsage`, optional, no default | `src/core/types.ts:1455` |
| `ContextUsage`, **19** members (not 7): `promptChars, budgetChars, pct, files, historyEntries, summaryAt, lastCompactionStep, tokensInWindow, budgetTokens, windowTokens, compactions, lastCompactionAt, compaction, budgetBoundBy, usdPerStep, windowTooSmall, recentSteps, promptBuildMs, refreshMs` | `:1645–1679` |
| `RecentStepsUsage { chars, allowanceChars, whole, clipped, oneLine, reads }` | `:1682–1689` |
| `Engine.compact?(): void`, a **real body** not a stub | `:1779`; `src/loop/engine.ts:1519–1523` |
| automatic triggers (every `compactEvery` steps, at 85 % of budget, on a resume past the history window) | `src/loop/engine.ts` `compactionDue`, `src/loop/context/compaction.ts` |
| `formatMeter(u)` producing `ctx 41% · 6 files · 12 steps` byte-for-byte | `src/loop/context/meter.ts:109–113` |
| `formatBudget(u, {maxSteps, spendCapUsd})` — money-capped, window-floor and plain forms | `meter.ts:95–107` |
| `formatRecentSteps(u)` — `recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)` | `meter.ts:89–93` |
| `MeterLevel = 'ok' \| 'amber' \| 'red'` with the 85/95 thresholds | `meter.ts:79`, `:83–84` |
| `--json=verbose` already carries the whole `ContextUsage` (it rides the `status` event) | `src/cli/json-stream.ts`, `src/cli/args.ts` |
| the compaction notice, identical in all three sinks by construction | `src/loop/engine.ts:3567` |

**Round 5's work on this topic is almost entirely the render path plus the config chain.** `src/tui/status/lines.ts`
(703 lines) has no `ctx` segment; `src/tui/commands/registry.ts` has no `context` or `compact` row; and the
`context.*` config chain is missing three layers deep (D-AI).

### 3.1 The `ctx` status cell (D-AG)

`'ctx'` joins `SegmentId` (`status/lines.ts:401`) and is pushed by `rightZoneSegments` (`:449`) behind one guard:

```ts
if (columns >= CONTEXT_MIN_COLUMNS && s.status?.context !== undefined) segments.push(seg('ctx', ctxText(s.status.context, ascii)));
```

- **Two rungs, not one gate (§14.2 #38).** `CONTEXT_MIN_COLUMNS = 80` admits the short form **`ctx 41%`** (7 cells,
  which fits beside `run $0.12/2.00` at 80); `CONTEXT_FULL_COLUMNS = 100` admits the whole `formatMeter` output
  `ctx 41% · 6 files · 12 steps` (28 cells). At 40 columns the cell is absent. This is the same rung pattern
  `meterText` and `gitZoneText` already use, and it is what makes requirement 3's "visible usage" true at the most
  common width — a single 100-column gate left it absent at 80.
- **`DROP_ORDER` (`:413`) becomes `['help', 'spark', 'git', 'ctx', 'peers', 'sess', 'wall']`** — seven entries, the
  **one** array quoted identically here, in §2.2, in §8.1 item 10 and in §9.2, landed once by R5-2 on behalf of both
  new segments (§14.2 #27, #45). `ctx` drops after git and before `peers`; per-run money (`'run'`) is never in the
  drop order and stays.
- **`ctxText`** calls `formatMeter` (the harness's own function — one source of truth) and then substitutes the
  separator for the active glyph set: `formatMeter(u).replaceAll(' · ', ' ' + g.dot + ' ')`, the same idiom
  `modeBadgeWord` already uses at **`src/tui/status/lines.ts:113–114`** (`:107` is an unrelated doc comment about
  the intake card's left word — §14.2 #23). The short rung is built from `u.pct` directly, not by truncating the
  long one. This is a stopgap; §8 REQUEST R4 asks the harness for an optional `g: GlyphSet` parameter on
  `formatMeter` so the substitution can be deleted (§7 row 40).
- **Absent is absent.** No placeholder, no `ctx —%`. `jev-off` goes to a different engine class entirely
  (`createGeneratorOnlyEngine`, routed at `src/cli/session.ts:777`, no `compact` method, no context bookkeeping);
  `jev-only` **and `llm-jev`** are excluded by `this.contextEnabled` at `src/loop/engine.ts:922`
  (`view === 'relaxed' && (mode === 'jev-on' || mode === 'jev-off')`).
- **The default mode is one of the excluded ones, and that is _not_ correct — it is a filed REQUEST (§14.2 #4).**
  An earlier draft wrote "Only `jev-on` shows a `ctx` cell today, and that is correct". It is not: `DEFAULT_MODE`
  is `'llm-jev'` (`src/config/defaults.ts:50`, flipped 2026-09-22), so requirement 3 would ship **invisible out of
  the box**. The contract's own doc comments read against the as-built guard — `types.ts:1345–1347` says
  `contextText` is built "for a synthesizer that prompts the generator itself (llm-jev)" and is absent only for
  "`jev-only`, `view: 'legacy'`", and `Engine.compact?`'s comment at `:1776` names the same two — and R11 §1.5
  (research line 126) reached the same reading. §8.2 **R13** asks the harness to add `'llm-jev'` to
  `engine.ts:922`, **gated before R5-3's W2**. Until it lands, §1.1 states the reduced scope and every empty state
  names `/mode jev-on` as the way to see the cell (§3.2, S55). §7 row 35 is re-worded accordingly.

**Amber and red carry a word and a notice, never colour alone — and the transition rule is stated, not implied
(§14.2 #57).** Two rules an earlier draft left open. (1) **Amber/red _replace_ the cell, they do not append**: the
files and steps counts are dropped in favour of the level word and the action, because at 87 % the actionable fact
is `/compact`, not "6 files". The cell is therefore `ctx 41% · 6 files · 12 steps` at `ok` and
`ctx 87% amber · /compact now` at amber/red, at **both** rungs (the short rung's amber form is the same string —
it is 24 cells and still fits at 80). `/compact now` lives **in the cell**, not only in the notice, because the
notice scrolls away and the cell does not. (2) **The crossing set is per _process_, not persisted**: a resume
re-announces a threshold already crossed. `ContextUsage.compactions` is explicitly "over the run's life, all
resumes" (`types.ts:1663`), so a persisted set would mean a user who resumes at 90 % is never told — the useful
behaviour is the re-announcement. §7 row 98 covers it. On every `status` tick the controller computes
`meterLevel(pct)` client-side; on the first crossing of 85 % and of 95 % **per process** it swaps the cell and
writes one line through `engine.annotate()` (**`src/core/types.ts:1783`** — `:1780` is `retryNow`'s doc comment,
§14.2 #22) so it lands in `transcript.log` too:

```
ctx 87% amber · /compact now
ctx 96% red · /compact now
```

This mirrors `crossedThresholds`'s pattern for money in `src/tui/budget/lines.ts` and needs **no engine change** and
no new event. It is what makes the signal reach `NO_COLOR`, `--ascii` and screen-reader users, which TD §14.1's
"a marker beside every colour" rule requires (§7 row 41).

### 3.2 `/context` — one block, three reads (D-AH)

`/context` is `availableDuringTask: 'any'`, `category: 'inspect'`, `plain: 'yes'`, and builds a `BlockRow[]` block
from three sources that are already public:

1. `engine.status().context` → the header numbers (`formatBudget`, `formatRecentSteps`, `pct`, `compactions`).
2. `engine.snapshotState()` (`types.ts:1758`, synchronous, already used for the last-resort checkpoint write) →
   `fileCache` (`FileCacheEntry { rel, pinnedBy: FilePin, lastUsedStep, bytesShown }`, `:1706–1712`;
   `FilePin = 'read'|'edit'|'human'|'jev'|'seed'`, `:1703`) and `fileMemory`
   (`FileMemoryEntry { sha12, bytes, readAt, editedAt }`, `:1715–1721`), joined by path to answer **why a file is
   in view**.
3. `CheckpointStore.readContextSummary()` on the store `src/cli/session.ts` already builds (guarded by
   `hasContextStore`, `src/checkpoint/types.ts:40`) → the rolling summary text, which lives only in
   `<runDir>/context/summary.json` and is written atomically at `src/loop/engine.ts:3558`. Reading the file
   directly also sidesteps the engine's own lazy re-read timing on resume (§7 row 39).

**The body** (heads and keys verbatim in §12):

```
context · step 12 · relaxed · code compaction
budget 70k chars of the 128k-token window (est. $0.014 per step)
recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)
prompt build 41 ms · file refresh 6 ms
summary at step 8 · 3 compactions · last 14:02
files in view · 6
  src/loop/engine.ts     41k   read at step 4 · edited step 6
  src/tui/App.tsx        12k   pinned by you
  …
```

**Three distinct empty states**, not one (§7 rows 35–37):

- no live run: `no run is live — /context reports the run's prompt budget`
- a mode that builds no relaxed context: `this run does not build a relaxed context (<mode>) — /mode jev-on builds
  one` (S55; **the sentence names the escape** rather than restating the emptiness, because for the default mode
  `llm-jev` this is the state a fresh install lands in until §8.2 R13 ships — §14.2 #4)
- before the first prompt: `no prompt built yet — /context fills in at the first step`

**`--json`.** There is no `jevcode context` CLI verb, so per the standing rule `/context` has **no `--json` of its
own**; the machine-readable form is the `ContextUsage` object already carried by `--json=verbose`'s `status` event.
§13 records this as a deliberate absence, not an omission.

### 3.3 `/compact`

`availableDuringTask: 'live'` — the **opposite** of Codex CLI's idle-only gate, and for a stated reason:
`Engine.compact?()`'s own doc comment (`src/core/types.ts:1774–1778`) frames it as folding history so the *next*
step's prompt fits, which is meaningless when no next prompt is being built. The refusal string is then free from
`availabilityError` (`src/tui/commands/registry.ts:599–603`), whose `'live'` branch returns
`error: /compact needs a live run`. Nothing hand-written.

**`compact()` returns `void`, so the "did it do anything" answer is a before/after comparison.** `compact()`
increments `this.compactions` and calls `emitStatus()` synchronously before returning (`engine.ts:3556`, `:3565`),
so the dispatcher reads `engine.status().context?.compactions` either side of the call and picks among three
strings:

| Case | String |
| --- | --- |
| the count rose | nothing new — the engine's own notice line (§3.4) already says what happened |
| the count did not rise, **`context.compaction !== 'off'`**, `context` present | `nothing to compact — only the newest step is in history` |
| **`status().context?.compaction === 'off'`** (checked **first**, §14.2 #15) | `compaction is off for this run (context.compaction) — jevcode config set context.compaction code turns it on` |
| `context` absent (`typeof engine.compact !== 'function'` or the mode excludes it) | `this run does not build a relaxed context (<mode>) — /mode jev-on builds one` |

**Why the `off` row must be checked first, and must exist at all.** `Engine.compact()`'s body is
`if (!this.contextEnabled || this.isFinished() || this.contextPolicy.compaction === 'off') return;`
(`src/loop/engine.ts:1520`) — with `compaction: 'off'` it returns **immediately, with no status emit and no change
to `compactions`**, so a two-row table falls through to row 2 and tells the user `nothing to compact — only the
newest step is in history`, which is a **falsehood**: there may be forty foldable steps. The state is observable
without a contract change — `ContextUsage.compaction: CompactionMode` (`src/core/types.ts:1669`) is already on
`status().context` — and `context.compaction` is the setting **§3.6 itself introduces**, so round 5 would be
shipping the bug and the setting that causes it in the same round. `context/lines.test.ts` gains the case (§10).

### 3.4 The compaction notice (D-AJ) — keep the line, decorate around it

The engine already emits, at `src/loop/engine.ts:3567`:

```
compaction: 41230 → 12840 prompt chars (code); 4 steps folded into the summary at step 8 (every 8 steps)
```

with `why` being one of `every <n> steps` · `prompt at <p>% of the context budget` · `resumed past the history
window` · `requested`. It is a `notice`, kind `ui`, label `[ui]`, so `itemsFromEvent`'s generic `notice` case
renders `e.text` verbatim in the TUI, in `--plain` and in `transcript.log` — the engine's own comment at `:3564`
states this as the rule ("ONE shared line in all three sinks"). **Round 5 changes none of it.** The TUI's only
addition is the optional `─ compaction ─` separator CO §8.6 allows ("the TUI may decorate… but never replace"),
drawn as a `rule` `BlockRow` above the notice when the pane is open and the terminal is ≥ 80 columns.

CO §8.6's shorter pinned form (`compaction: 41k → 12k chars (code)`) is **reconciled to the as-built line in the
design doc**, not the other way round; §15 Q3 files that one-line documentation fix with the peer.

### 3.5 What `opencode` and the others actually show, and what round 5 takes

- **opencode** puts the meter in the sidebar, always visible, as three plain lines — `"{tokens} tokens"`,
  `"{percent}% used"`, `"{money} spent"`, with `percent = round(tokens / model.limit.context * 100)`
  (`docs/research/tui/01-opencode.md:164–166`, source `packages/tui/src/routes/session/sidebar.tsx`). `/compact`
  (alias `/summarize`, `<leader>c`) posts to `/session/:id/summarize`. **Taken:** always-visible, percent-first,
  no colour grid. The user's own words for this requirement were "relaxed like opencode with visible usage".
- **Claude Code**'s `/context` is a categorised live breakdown — system prompt, tools, memory files, skills,
  conversation history, free space and the autocompact buffer — closing with a suggestions block naming how many
  tokens are recoverable ([code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window);
  [wmedia.es walkthrough](https://wmedia.es/en/tips/claude-code-context-command-token-usage), both fetched
  2026-09-22). Its status-line JSON exposes `context_window.used_percentage` /`.remaining_percentage` /
  `.context_window_size`. **Taken:** the per-section breakdown with a reason per row (JevCode's "read at step 4 ·
  edited step 6 · pinned by you"). **Not taken:** the coloured grid — JevCode's rule is a word beside every colour,
  and a grid is colour-only.
- **Aider**'s `/tokens` breaks the context down by component (system messages, chat history, repo map) against the
  model limit ([aider.chat/docs/usage/commands.html](https://aider.chat/docs/usage/commands.html)) — the same
  per-section shape from a much older tool, which is evidence the shape is right, not novel.
- **Cursor** drops old messages at 100 % rather than summarising
  ([forum.cursor.com thread](https://forum.cursor.com/t/where-did-context-window-fill-indicator-go/156687)). This
  is the counter-example CO §8.5's "never truncated silently" rule exists to avoid: every JevCode clip carries a
  recovery pointer (`jevcode:outputs/step-<n>.txt`, and `HistoryEntry.outputEvicted` at `types.ts:1699` when even
  that is gone).

### 3.6 `context.*` config — the whole chain (D-AI)

Five `SettingName` rows, one per `ContextPolicyOptions` member, added to `src/config/types.ts:6–63`:

| Setting | Type | Default | Env | Flag |
| --- | --- | --- | --- | --- |
| `context.mode` | `relaxed \| legacy` | `relaxed` | `JEVCODE_CONTEXT_MODE` | — |
| `context.compaction` | `code \| llm \| off` | `code` | `JEVCODE_CONTEXT_COMPACTION` | — |
| `context.kept` | `code \| jev` | `code` | — | — |
| `context.compactEvery` | integer ≥ 0 (0 disables) | `8` | — | — |
| `context.budgetChars` | integer ≥ 1, override | derived | — | — |

Plus the two pieces without which the rows are dead code exactly like the hook already in the tree:

1. A small `resolveContextConfig(reader)` in `src/config/resolve.ts`, mirroring `src/config/ui.ts`'s
   `enumSetting`/integer pattern, wired to `ResolvedConfig.context()` (`src/core/types.ts:2076`) — **and the false
   claim in that member's doc comment ("`config/resolve.ts` always sets it") becomes true**.
2. One line at each engine-construction site in `src/cli/session.ts`: `contextPolicy: rcfg.context?.()`, feeding
   `EngineOptions.contextPolicy` (`:1248`), which is referenced nowhere in that file today.

`jevcode config` prints and validates them exactly like `ui.renderer` does after round 4; `jevcode config set
context.compaction off` persists.

### 3.7 Behaviour at 40, 80 and 120 columns

| Surface | 40 | 80 | 120 |
| --- | --- | --- | --- |
| `ctx` status cell | absent (below `CONTEXT_MIN_COLUMNS = 80`) | **`ctx 41%`** — the short rung (§3.1) | `ctx 41% · 6 files · 12 steps` — the full rung at ≥ `CONTEXT_FULL_COLUMNS = 100` |
| `ctx` cell at amber/red | absent | `ctx 87% amber · /compact now` (replaces, never appends) | same |
| amber/red notice | full sentence (it is a transcript item, not a cell) | same | same |
| `/context` block | header + `files in view · 6` count only; per-file rows drop the reason column | header + reasons, paths shortened by `shortPath()` (TD4 §3.4) | whole |
| `─ compaction ─` rule | not drawn | drawn | drawn |

---

## 4. The agent tree and its control surface

### 4.0 Scope, stated first

Round 5 builds **everything except the process manager**: the 16 row states, the four cards, the `'a'` pane tab,
the seven commands, the 34 settings, the nine CLI flags, the manifest confirm's four fields and their five
count-preserving render branches, and the `jevcode agents list` shell twin — all against typed fixtures, all
tested, all invisible in production until real rows exist. `AgentSupervisor` (OR §8.3 item 34, ~620 LOC) does
**not** start (N1, §4.7).

`grep -rln "orchestrat" src/tui` returns zero matches in this worktree; `src/tui/pane/agents.ts`,
`src/tui/agents/lines.ts`, `src/cli/agents.ts` and `src/cli/agent-supervisor.ts` do not exist. This is greenfield.

### 4.1 Build against `src/orchestrate/index.ts`, not `core/types.ts` (D-AK)

`src/orchestrate/index.ts:21–46` exports today: `AgentRef, AgentRole, AgentRow, AgentSpec, AskFn, Clock,
CommitIdentity, DemandReason, DraftAgent, DraftSplit, GateReason, LandAttempt, Manifest, NormalizedSplit,
NormalizeResult, RankedSplit, RejectedOption, RunGit, RunGitOptions, SplitKind, SplitPolicy, SyncedDirtyEntry,
AgentState, VerifyResult` plus `DEFAULT_SPLIT_POLICY`. `src/orchestrate/types.ts:1–13`'s own header says the move
to `src/core/types.ts // contract 1.5` is "a relocation, not a reshape". Round 5 imports from
`src/orchestrate/index.js` and adds **one** line to each importing file's header naming the future move, so the
later re-point is a mechanical find-and-replace.

**`import type` only, and no value crosses (§2.1 rule 6, §14.2 #14).** `src/orchestrate/index.ts` is a **value**
module — `DEFAULT_SPLIT_POLICY` (`:47`), `readManifest`/`writeManifest` (`:108`), `dirtySnapshot` (`:114`) — whose
dependency graph reaches `node:fs/promises` (`worktree.ts:29`, `land.ts:40`, `manifest.ts:22`). Every TUI import of
it is therefore `import type { AgentRow, AgentState, Manifest, … } from '../../orchestrate/index.js'`, which erases
at compile time and leaves the first-frame graph untouched. Where round 5 wants a **value** — the 16 `AgentState`
words, a default split policy for a fixture — it declares it TUI-side as a `Record<AgentState, string>`, which
`tsc --strict` proves total against the imported union (§4.2). Gate **G-R5-1** names `orchestrate/index.js` in its
assertion list.

`AgentState` (`src/orchestrate/types.ts:27–43`) is the 16-member union round 5 renders:
`planned, starting, running, paused, parked, review, stalled, done, landing, landed, conflicted, failed-verify,
kicked, dropped, crashed, failed-start`.

### 4.2 One pure function, four render targets

```ts
// src/tui/agents/lines.ts (new)
export function agentRowText(r: AgentRow, o: { width: number; g: GlyphSet; sr?: boolean }): string
export function agentRows(rows: readonly AgentRow[], o: …): BlockRow[]
export function agentStripText(rows: readonly AgentRow[], o: …): string   // the collapsed status-line form
export function agentCard(kind: 'manifest' | 'resume' | 'land-preview' | 'review', …): BlockRow[]
```

The Ink tab (`src/tui/pane/agents.ts`), the `--plain` twin (`src/tui/plain.ts`), the screen-reader twin and
`jevcode agents list` all call these. No second string exists anywhere; §13 pins them.

**`jevcode agents list` needs a `Command` member, and an earlier draft never added one (§14.2 #7).** The verb is
named as a deliverable in §4.2, §9.1 (`src/cli/agents.ts`, **new**), §10 (`cli/agents.test.ts`), §11 (G-R5-10) and
§13.3, but `Command` (`src/cli/args.ts:19–20`) is
`'chat'|'run'|'config'|'bench'|'perf'|'login'|'logout'|'sessions'|'report'|'why'|'calibration'|'completion'|'upgrade'`
and gains only `'import'` and `'models'` in the draft — so the verb was **unreachable**, and G-R5-10's "`Command`
has exactly its expected members" would have passed with it absent. **`Command += 'agents'`** joins §8.1 item 10
and §9.2's `src/cli/args.ts` row as R5-4's request: the union, the `COMMANDS` array (`:20`), the usage text, and a
`case 'agents':` arm in `src/cli/main.tsx`'s `switch (command)` (`:425–484`). G-R5-10 now names all three new
members literally so it cannot be vacuous.

**`agentRowText` replaces the engine's `decomposeBody()` (`CD §F` to-do 3).** The harness currently renders the
decompose proposal's body itself; once contract 1.5's `agent:*`/`decompose:*` events are in the tree, the engine's
copy is deleted and the `orchestration:proposed` / `agent:adopted` payloads are rendered through `agentRows` /
`agentCard('manifest', …)`, so there is exactly one row grammar. The deletion is a **harness** hunk (§8.2 R15);
round 5's side is the consumer, which exists either way.

**The 16 row-state words (OR §4.6, verbatim).** `planned` → `queued` · `starting` → `starting` · `running` →
`step n/m <stage>` · `paused` → `paused (you)` · `parked` → `parked (<why>)` · `review` → `needs approval` ·
`stalled` → `no progress 11 m` · `done` → `done, not landed` · `landing` → `landing` · `landed` →
`landed @<sha7>` · `conflicted` → `conflicts in <path>` · `failed-verify` → `<cmd> failed` · `kicked` →
`kicked (1/1)` · `dropped` → `dropped` · `crashed` → `crashed at step n (<stage>)` · `failed-start` →
`failed to start (<code>)`.

**A row is never hidden while the agent exists.** Above 12 rows the tab scrolls; it never filters. This is the rule
that answers the two documented failure modes in the nearest peers: opencode's child sessions drop the sidebar
entirely on entry, so a child has "no context usage or cost for that session"
([sst/opencode issue 48548](https://github.com/sst/opencode/issues/48548)), and Claude Code's background subagents
"give the user zero visibility" while the model waits
([anthropics/claude-code issue 95730](https://github.com/anthropics/claude-code/issues/95730)) and can "display as
running indefinitely" after a crash with no reaper
([issue 94872](https://github.com/anthropics/claude-code/issues/94872)).

### 4.3 The `'a'` pane tab

`PaneTab` (`src/tui/pane/model.ts:245`) is `'d' | 'p' | 't' | 's'`; `PANE_TABS` (`:246`) is the same four;
`cycleTab(tab, dir)` (`:307–310`) indexes `PANE_TABS` directly. Round 5's change is exactly OR §4.6 [G20]/[D7],
**with the constant split the review forced (§14.2 #1, #31)**:

```ts
export type PaneTab = 'd' | 'p' | 't' | 's' | 'a';
/** UNCHANGED: the four production tabs. `cycleTab`'s default binds to THIS. */
export const PANE_TABS: readonly PaneTab[] = ['d', 'p', 't', 's'];
/** the five-tab list, used only while something is delegating */
export const PANE_TABS_WITH_AGENTS: readonly PaneTab[] = ['d', 'p', 't', 's', 'a'];
export function paneTabsFor(hasDelegation: boolean): readonly PaneTab[];   // WITH_AGENTS when true, PANE_TABS when false
export function cycleTab(tab: PaneTab, dir: 1 | -1, tabs: readonly PaneTab[] = PANE_TABS): PaneTab;
```

**Which constant the default binds to is the whole point.** An earlier draft widened `PANE_TABS` itself to five
members *and* defaulted `cycleTab`'s third parameter to it, then claimed
"`test/unit/tui/pane/model.test.ts:165–167` … must stay green unchanged". Both cannot be true:
`:165–167` asserts `cycleTab('s', 1) === 'd'` and `cycleTab('d', -1) === 's'`, and against a five-member list
index 3 + 1 = 4 → `'a'` and index 0 − 1 + 5 = 4 → `'a'`, so the two-argument form's answers change and the test
goes red. Binding the default to the **four-tab** `PANE_TABS` keeps `:165–167` green *and unedited*, which is what
the design promised; `paneTabsFor(true)` returns `PANE_TABS_WITH_AGENTS` and is passed explicitly at every
agents-aware call site.

**Every `cycleTab` caller, verified (§14.2 #31).** There are exactly three outside the function itself:
`src/tui/App.tsx:1419` (`dispatch({ type: 'tab', tab: cycleTab(s.tab, action.dir) })` — the `]`/`[` route),
`paneRuleRow` (`src/tui/pane/model.ts:356`, the side-by-side next-tab title) and `paneLines`
(`:476`, the side-by-side right column). All three pass `paneTabsFor(state.agents.length > 0)`. `App.tsx` is
**not** an R5-4 file — §9.2 gives it an owner row and R5-4's hunk verbatim.

**A fourth hardcoded tab list the earlier draft never named.** `paneRuleRow`'s strip is a **literal string**, not a
list comprehension: `` const tabs = ` [d]ecisions [p]lan ${wide ? '[t]imeline' : '[t]ime'} [s]ynth ` ``
(`src/tui/pane/model.ts:355`), with a second literal at `:377`
(`' [d]ecisions [p]lan [t]imeline [s]ynth '` / `' [d] [p] [t] [s] '`). F-54's rule row `d p t s [a]` is a
**different grammar** from the landed one and would be a second convention. Round 5 keeps the landed grammar and
appends one segment while delegating: `` [d]ecisions [p]lan [t]ime [s]ynth [a]gents `` (wide) /
`` [d] [p] [t] [s] [a] `` (narrow), computed from `paneTabsFor(...)` so the two literals become one builder.
**F-54 is corrected to this form** (§4.11).

Three more places the literal list is written down and must become computed:

- `TAB_TITLE` (`model.ts:322`) is a total `Record<PaneTab, string>` — it gains `a: 'agents'`, and TypeScript's
  exhaustiveness check finds this for free.
- `PANEL_ARGS` (`src/tui/commands/registry.ts:97`) is `['d','p','t','s','off','full']`, consumed by
  `parsePanelCommand`/`nextPanel` (`src/tui/pane/commands.ts:22`, `:32`, `:42`) — it gains `'a'`. `nextPanel`'s parameter
  is already `PaneTab | 'off' | 'full' | null`, so it widens for free.
- `src/tui/keys/bindings.ts:72–73`'s two titles are today the static strings
  `'next pane tab (d → p → t → s); opens a collapsed panel'` and `'previous pane tab; opens a collapsed panel'`.
  They become computed, per OR §4.6: `next pane tab (d → p → t → s, + a while delegating)`.

`KeyContext` (`src/tui/keys/bindings.ts:12`, five members today; `KEY_CONTEXTS` at `:15`) gains a sixth member
`'agents'` for the tab's own keys (`Enter` attach read-only · `p` pause · `t` steer · `+` budget · `d` diff ·
`k` kick · `x`+`x` drop · `l` land).

**The tab needs a focus model, or those eight letters go into the composer (§14.2 #41).** `resolveKey`'s precedence
chain is **Minsize · Overlay · Picker · Composer · Global** (`src/tui/keys/resolve.ts:5`) — there is **no pane
rung**, and `PaneOverlay` (`src/tui/pane/model.ts:249`) only asks whether an overlay is `'none'`; nothing under
`src/tui/pane/**` holds focus. A sixth `KeyContext` with nowhere to sit means `p` types a `p`. So:

- `UiState` (`src/tui/useEngine.tsx:185`, beside `tab: PaneTab`) gains **`paneFocus: boolean`**, with a
  `{ type: 'paneFocus'; on: boolean }` action beside `{ type: 'tab' }` (`:283`).
- **`Alt+A` focuses the agents tab and Esc unfocuses it** (S66 already advertises `/agents (Alt+A)`). `/agents`
  opens *and* focuses. Focus is dropped automatically when `paneTabsFor(...)` stops containing `'a'`.
- `resolveKey` gains **one rung, between Picker and Composer**: `agents` resolves only when
  `ui.paneFocus === true && ui.tab === 'a'`. Placing it below Picker keeps the resume card's sub-state (§2.8)
  unambiguous; placing it **above** Composer is what makes the eight single letters reachable at all.
- The focused strip says so, so the state is never invisible: the rule row's right edge reads
  `[a]gents · Esc unfocuses` while focused.
- §7 row 99 covers "a key pressed while the agents tab is focused and the composer already has text": **focus is
  refused while the draft is non-empty** (the same `when: 'empty draft'` guard `global:paneNext` already carries,
  `src/tui/keys/bindings.ts:72`), and `Alt+A` with a draft answers `finish or clear the line first — Alt+A then
  focuses the agents tab` (S86a). `src/tui/keys/resolve.ts` and `src/tui/useEngine.tsx` both get §9.2 owner rows.
**`x` twice** for drop, not once: tmux's `choose-tree` kills a pane with a single `x`, but a tmux pane kill loses
no committed work, whereas dropping an agent loses its uncommitted diff — the extra keystroke is the difference
([tmux choose-tree reference](https://waylonwalker.com/tmux-choose-tree/), fetched 2026-09-22).

### 4.4 The collapsed strip and the status line

```
agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓
agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)
```

The `(+$0.06)` is OR §6.3's worst-case per-process overshoot, carried on `EngineStatus.orchestration` when it
lands — not a number the render layer computes. Until `EngineStatus.orchestration` exists (§8 REQUEST R3) the strip
is fed by fixtures in tests and is absent in production.

**The strip is a third new `SegmentId`, and the earlier draft forgot to declare it (§14.2 #45).** `SegmentId`
(`src/tui/status/lines.ts:401`) gains **`'agents'`** as well as `'ctx'` and `'peers'`; without it `seg('agents',
…)` does not compile. It is pushed **third, right after `run`** (§2.2's stated order) because it spends the run's
money, and it is **not in `DROP_ORDER`** — like `'run'`, live agents spending money are never dropped; instead the
strip's own text shortens (`agents 3 · $0.41/0.90` at 40, the full form at 80+). `AGENTS_MIN_COLUMNS = 40`.
Separately, `StatusZones['dropped']` (`:497`) is a **separately spelled** union
`('badge'|'help'|'spark'|'git'|'sess'|'wall'|'centre')[]` that `dropped.push(d)` (`:543`) writes into from
`DROP_ORDER` — it must gain `'ctx'` and `'peers'` in the same edit or `tsc --strict` rejects the push. Both are in
§8.1 item 10 and in §9.2's `status/lines.ts` row.

### 4.5 `/pause`, `/end` and the exit gate, with agents live

The scope grammar's orchestration half is **deferred** (D-AE), but the three confirm ladders are designed now
because they are pure `fitRung` rows and because the exit gate is reachable the moment any child exists:

```
pause this session: [y] tree (3 agents at their next step)  [Y] tree now  [t] this run only  [n] stay
abort 3 agents too? [y] all  [t] this run only  [n] cancel
3 agents live: [k] keep them running (they keep spending) · [e] end them · [n] stay
3 pause requests sent · 1 acked · 2 pending (they finish their step)
```

**Two `CD §F` to-dos land here.** (1) **The `[G7]` parking blocker.** A delegating parent at depth 1 must park
rather than prompt, so `src/cli/session.ts`'s two engine-construction sites —
`...(o.interactive || prompter?.blocking ? { blocker } : {})` at **`:2066`** and **`:2390`** (verified in this
worktree) — become `...(o.interactive || prompter?.blocking || o.orchestration?.depth === 1 ? { blocker } : {})`
with `const parkingBlocker: EngineOptions['blocker'] = async () => 'pause'` selected when
`o.orchestration?.depth === 1`. This needs `SessionControllerOptions.orchestration`, which arrives with the
`--agent`/`--parent`/`--manifest`/`--own` flags — **slot R5-4**, landed through §9.2's `src/cli/session.ts` row
(owner R5-1). (2) **`src/undo`'s `landedUndoOffer` / `rewindRefusal`.** Once an agent has landed, `/undo` must
offer to undo the *merge* rather than the last local step, and `/rewind` must refuse across a land boundary with a
named reason: `step 7 landed 3 agents — /undo reverts the merge, /rewind cannot cross a land` (S76a). Owner
**R5-4** (it owns the agent surface); `src/undo/{diff,plan,pager}.ts` join its §9.1 cell.

**The headless exit-code trap, stated so the implementation cannot fall into it.** A delegating parent's own stop
reason at P9 is `human_pause`, which `exitCodeFor` maps to **exit 4** — the same code a budget exhaustion uses —
while children are still live and spending (OR §4.9 [G12]). `--no-wait` therefore prints an explicit, different
sentence rather than relying on the code: `delegated: 3 agents running; jevcode agents list follows them`.

### 4.6 The manifest confirm (D-AM)

`ConfirmRequest` (`src/core/types.ts:693–702`) gains four optional members (§8 item 5, a REQUEST to the peer since
this is a contract-1.5 shape). The five count-preserving branches — `confirmPreviewLines`, `reviewHeaderLines`,
`reviewCardLines`, `reviewScreenReaderLines` and `reviewTitle`/`reviewCardTitle` — substitute rows rather than
adding them, so `CONFIRM_HEADER_ROWS = 8` (`src/tui/plain.ts:517`) is unchanged and the existing `it.each` review
test extends from n = 8 down to n = 2.

**Why the fields are needed at all:** `proposal` and `risk` are *required* on `ConfirmRequest`, and
`describeAction('read').preview` is the empty string, so a manifest confirm faked as a synthetic `read` action
renders a blank body ([G2]). **The property test that must pass:** no rendered row of a manifest confirm contains
any substring of `risk` or `proposal` — the card is a proposal *about a plan*, not about an action, and
`no risk dimensions on this card — this is a proposal, not an action` is the line that says so.

**Body and headline, verbatim:**

```
3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test, npm run typecheck
```
```
⚠ your checkout has 7 uncommitted files; 2 of them (src/tui/Pane.tsx, src/loop/engine.ts) are inside an agent's
  slice — /land will ask you to commit or stash those two before it merges
```

`badge` carries `agent <slug>` so that when two children are blocked at once nobody approves the wrong thing.

**The `review:why` refusal (`CD §F` to-do 2).** `review:why` is the `w`-then-`1–5` chord that explains one risk
dimension (`src/tui/keys/resolve.ts:62`). A manifest confirm has **no risk dimensions** — that is the whole point
of the property above — so the chord must refuse rather than index into an empty array. The rule:
**while `ConfirmRequest.headline` is set, `review:why` is refused** with
`no risk dimensions on this card — this is a proposal, not an action; [Enter] approves, [d] declines` (S65,
extended). `headline` (not `badge`, not `title`) is the discriminant because it is the field OR §3.7 defines as
present on exactly the manifest shape. `review.test.tsx` asserts the refusal for all five `w 1` … `w 5`.

**The `split: 'auto'` rule is hard, not a preference:** the human confirm is skipped **only** when every agent in
the manifest has `role: 'research'` (`AgentRole` at `src/orchestrate/types.ts:24`). One code-writing agent in an
otherwise-auto manifest forces the ordinary `[y]` gate, and the fixture test asserts this for a 4-agent manifest of
3 research + 1 code.

### 4.7 `AgentSupervisor` — why it waits, and what it inherits

It needs two harness deliverables that are absent from this worktree: contract 1.5 in `src/core/types.ts`, and the
`decompose` stage plus the P9/P10 engine wiring (`StageName` at `:243` has 8 members and no `'decompose'`;
`PausePointReason` at `:1543` has 5 and no `'delegate'`/`'review-needed'`). Without them there is no
`pause:point{reason:'delegate'}` to create it lazily at, no manifest to confirm and no real caller to test it
against.

What round 5 hands its eventual author: a fully specified, already-tested consumer — `agentRowText` /
`agentRows` / `agentCard` over `AgentRow[]`, the 16 fixture rows, the four cards, the tab, the seven commands and
their dispatch, and `jevcode agents list --json`. Adoption is a **row fold**, not a rendering change:
`adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked)`.

**The one rule round 5 writes down now so the supervisor cannot get it wrong:** caps are checked against the **live
fold**, never a persisted counter —
`listSessions(fold, self).filter(a => a.heartbeat.parentRunId === myRunId && a.liveness === 'live').length`
(`src/coordination/fold.ts:387`) — so a resumed or adopted child counts against `orchestrate.maxAgents` and a
resume can never silently take a free slot (§7 row 48).

### 4.8 The 34 `orchestrate.*` settings and the nine CLI flags — buildable today

`src/config/{types,defaults,resolve,ui,validate}.ts` have no `orchestrate.` prefix. OR §8.3 item 26 has **no**
dependency on contract 1.5 — config schema rows are pure data. The flags (`src/cli/args.ts`): `--parent`,
`--parent-session`, `--agent`, `--manifest`, `--own`, `--base`, `--split`, `--max-agents`, `--yes-split`,
`--no-wait`.

**The thirty-four names, enumerated (§14.2 #19).** An earlier draft cited only a *count* and then wrote a gate
phrased "every `orchestrate.*` name **this document mentions** has a `SETTINGS` row" — and the document mentioned
two, so the gate was vacuous for the other thirty-two and could not catch a missing or misspelled key. Every name,
default and env variable is `docs/ORCHESTRATION-DESIGN.md` §6.4's table, read in this worktree at
`docs/ORCHESTRATION-DESIGN.md:1427–1461`; **that table is the authority** and G-R5-8 now cites it by line rather
than citing this document. The names, in OR's own order, so a reviewer can diff them:

`orchestrate.` **`split`** (`off`, `--split`) · **`maxAgents`** (3, `--max-agents`) · **`maxSplits`** (2) ·
**`splitEvery`** (8) · **`preludeMaxFiles`** (8) · **`selfContainedFloor`** (0.5) · **`reserveFraction`** (0.5) ·
**`maxReserveUsd`** (2.00) · **`minAgentUsd`** (0.20) · **`agentMaxSteps`** (12) · **`agentMaxWall`** (15 min) ·
**`agentStallMs`** (10 min) · **`onStall`** (`notify`) · **`maxKicks`** (1) · **`critic`** (`tests`) ·
**`criticCapUsd`** (0.15) · **`criticMaxSteps`** (4) · **`criticWriteGlobs`** · **`verify`** (`[]`) ·
**`verifyRetries`** (0) · **`testGlobs`** · **`land`** (`step`) · **`incidentalGlobs`** (`[]`) ·
**`agentMode`** (`worktree`) · **`agentInclude`** (`['.env','.env.*']`) · **`commitIdentity`** ·
**`dockCleanExclude`** · **`dockRetentionDays`** (30) · **`notify`** (`attention`) · **`agentWaitCeilingMs`**
(30 min, `--no-wait` disables the wait) · **`agentJsonLineBytes`** (64 KiB) · **`agentDeltaHz`** (4/s) ·
**`minFreeBytes`** (2 GiB) · **`agentMemBytes`** (3 GiB) — **34**. Every env name is
`JEVCODE_ORCHESTRATE_<SCREAMING_SNAKE>`; all are `secret: false`; none is a launch setting; `depth` is a
**constant, not a setting** (OR's own row) and `--yes-split` is a **flag, not a setting**, recorded in
`RunMeta.overrides`. The self-contained property test is `contract.test.ts`: every key in OR §6.4's table has a
`SETTINGS` row, and no two slots claimed the same key (§10, §11 gate G-R5-8).

`orchestrate.maxAgents` defaults to **3**, clamped by `coordination.maxChildren`. Cursor 3's Agents Window caps at
8 across all repos with a worktree per agent
([cursor.com/changelog/3-0](https://cursor.com/changelog/3-0); walkthrough at
[digitalapplied.com](https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide), fetched
2026-09-22) — the same shape of decision with a different cost model. §15 Q8 asks the owner whether 3 is
deliberate conservatism or a placeholder pending OR's M10 measurement.

### 4.9 Commands, registered honestly from day one (D-AN)

Seven rows, all landing in the one `registry.ts` PR (§9.2), each answering
`<verb> is not available in this build — no agent is running` until its store exists:

| Command | Usage | Availability | Notes |
| --- | --- | --- | --- |
| `/split` | `/split [auto\|ask\|off]` | `any` | pends the split policy for the next step |
| `/agents` | `/agents` | `any` | opens the `'a'` tab (or the block, in `--plain`) |
| `/agent` | `/agent <slug> <verb> [args]` | `any` | `pause`/`resume`/`steer`/`budget`/`land`/`kick`/`drop`/`diff` |
| `/land` | `/land [<slug>]` | `idle` | joins `EXCLUSIVE_COMMANDS` (`src/cli/session.ts:218`, today 11 members) |
| `/spawn` | `/spawn <role> <glob> [task]` | `live` | one extra agent against the live manifest |
| `/pause` | widened, §2.6 + scope later | **`any`** (§14.2 #16) | `'live'` would refuse `/pause <target>` — a message to a peer — from an idle TUI; the local-form refusal is hand-written (S45a) |
| `/end` | widened, §2.7 + scope later | `any` | the no-run answer is S45b, not `availabilityError`'s |
| `/agents` | `/agents` | `any` | also **focuses** the tab (§4.3); `Alt+A` is the key twin |

`/land` is the only one of the seven that mutates files, so it is the only one that joins `EXCLUSIVE_COMMANDS` and
the only one with `destructive: true` (a confirm row whose Enter is inert, TD4 §4.5).

### 4.10 `/cost` with holds

`sessionRemainingUsd(sessionCapUsd, sessionSpentUsd, heldUsd = 0)` is **already the right signature** in the
TUI-owned file (`src/tui/budget/lines.ts:188`, exact 3-argument match to OR [D6]).

**There are four two-argument call sites in this worktree, not two, and the two the earlier draft missed are the
ones that gate money (§14.2 #36).** Besides `src/cli/session.ts:2021` and `:2347`, **`childCapUsd`
(`src/tui/budget/lines.ts:194–195`) and `followUpDecision` (`:202–203`) both call
`sessionRemainingUsd(sessionCapUsd, sessionSpentUsd)` with two arguments** — and those two decide whether a child
run or a follow-up is admitted at all. Left as they are, a follow-up would be admitted against budget **already
reserved for live agents**, which is precisely the double-spend [D6] exists to prevent. `main` has already fixed
this (`d8490fa`, "childCapUsd / followUpDecision pass heldUsd through"; the 3-argument signature itself since
`5291e9b`) — **neither commit is an ancestor of this worktree** (`git merge-base --is-ancestor d8490fa HEAD` →
false), which is why the draft read the old code. The remaining TUI-side work is therefore: **confirm the two
`budget/lines.ts` sites after the rebase onto `main`** (gate G-R5-11's sweep), and swap the two
`src/cli/session.ts` calls to the 3-argument form once `meter.heldUsd()` is available (§8 REQUEST R2, which `CD §F`
records as already landed on `main`). `/cost`'s line then reads:

```
run $0.12 · agents $0.31 (3 runs) · session $0.43/2.00 · held $0.29 · free $1.28
```

with the arithmetic checkable by eye: `free = session cap − session spent − held`. `free` must never double-count a
released hold, which the property test in §10 asserts over a hold/release sequence.

### 4.11 Frames

**F-54. the agents tab at 120×40 (D 14), five of the sixteen states.** The rule row uses the **landed** strip
grammar (`src/tui/pane/model.ts:355`, `:377`) with one segment appended while delegating — not the `d p t s [a]`
form an earlier draft drew, which was a second convention (§14.2 #31). The keys row is reachable because the tab
is **focused** (`Alt+A`, §4.3); unfocused, the same rows render and the letters go to the composer.
```
── agents ─────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth [a]gents ──
 ● tui-rows       step 4/12 propose   $0.11/0.30  6m  jevcode/tui-rows@3f9a2c1
 ⏸ fix-store      paused (you)        $0.08/0.30  4m  jevcode/fix-store@8bc0d11
 ⚠ test-fixture   needs approval      $0.05/0.30  3m  jevcode/test-fixture@8bc0d11
 ✓ dock-a2fee9c1  landed @8bc0d11     $0.17/0.30  9m  npm test ✓ (412) · typecheck ✓
 ✗ lint-pass      npm run lint failed $0.03/0.30  1m  jevcode/lint-pass@3f9a2c1
 Enter attach · p pause · t steer · + budget · d diff · k kick · x x drop · l land
──────────────────────────────────────────────────────────────────────────────────
```

**F-55. the collapsed strip in the status line at 80 columns.** Segment order is §2.2's one order —
`step · run · agents · sess · … · ctx · peers` — so `agents` follows `run`, and F-51 and F-55 now agree
(§14.2 #45).
```
 ⏺ step 11/40 execute   run $0.12/2.00   agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90
```

### 4.12 Behaviour at 40, 80 and 120 columns

| Surface | 40 | 80 | 120 |
| --- | --- | --- | --- |
| agents tab row | `● tui-rows  step 4/12 propose` | + `$spent/cap` and wall | + branch@sha and the verify column |
| collapsed strip | `agents 3 · $0.41/0.90` | full | full |
| keys row | `Enter · p · t · x x · l` (rung 4) | rung 2 | rung 1 |
| manifest confirm body | one glob per row, stacked | the `·`-joined form | the `·`-joined form |

---

## 5. The import surface — "import all memory/workflows at onboarding"

### 5.0 The facade is finished; the whole TUI side is greenfield

`src/import/index.ts` is a 699-line module whose own header states the contract ("the only module the CLI and the
TUI session import… it performs no writes"). Verified exports, this worktree:

| Symbol | Line | Shape |
| --- | --- | --- |
| `newImportId(now, seed?)` | `:160` | `imp_<compact ISO>_<6 hex>`, pure |
| `isImportId(value)` | `:167` | `/^imp_\d{8}T\d{6}Z_[0-9a-f]{6}$/` |
| `planImport(opts)` | `:322` | phases 1–3, writes nothing |
| `probe(opts & {deadlineMs?})` | `:584` | default `deadlineMs: 50` — the wizard's probe |
| `summarisePlan(plan)` | `:648` | `PlanSummary { groups, toImport, toReview, skipped, bytes, credentialsFound }` |
| `applicableRows(plan, {scope})` | `:680` | excludes `review`, `suggest`, every `skip:*` **and every `class === 'secret'` row** |
| `asImportPlan(value)` | `:694` | narrows a `Json` — `v === 1`, `importId: string`, `Array.isArray(rows)` |
| `applyPlan` / `resumeImport` / `undoImport` | re-exported `:134` / `:142` / `:145` | phase 4 over the caller's write seam |
| `ImportWriteFs` | via `export * from './types.js'` at `:57` | **not a named export**; defined `src/import/types.ts:484` |
| `render(row, sourceText)` / `sourcePath(row)` | `src/import/apply.ts:391`, `:393` | **not exports** — fields the caller implements on `ApplyOptions` |

Verified absent (everything the TUI needs): `Command` union (`src/cli/args.ts:19`) has no `'import'`;
`src/cli/import.ts`, `src/config/imports.ts` and `src/tui/import/**` do not exist; `WizardStep`
(`src/tui/onboarding/reducer.ts:26`) has 13 members and no `'import'`; `OverlayKind` (`src/tui/layout.ts:52`) has
10 and no `'import'`; `COLLAPSING` (`:58`) has 5; `INDEX_KINDS` has no `'import'`; `SettingName` has no
`import.*`/`memory.*`; `FactKey` (`src/chat/facts.ts:17`) has 14 and no `memory` fact.

### 5.1 The wizard step

`WizardStep` gains `'import'`, between `'sandbox'` and `'done'` (IM §5.1). The step is gated on `probe()`
(`src/import/index.ts:584`, default `deadlineMs: 50` at `:595`), run **after the first frame and after the sandbox
step** — never on the argv path — with its own ≤ 50 ms deadline. If the probe finds nothing the step does not
render at all.

**`probe` is reached through `await import('../../import/index.js')`, never a static import (§2.1 rule 3a,
§14.2 #35).** `src/tui/onboarding/**` is a first-frame module; a top-level `import { probe }` would pull all of
`src/import/**` onto the argv path through `src/cli/main.tsx:31`'s static `./session.js`. The wizard reducer holds
`ImportProbe` as an `import type` and the Wizard component awaits the module inside the same post-first-frame
effect that runs the probe. Gate **G-R5-1** names `import/index.js`.

```
Import your memory and workflows?  found claude-code (43 notes), codex (3 servers)
 1 import now   2 later   3 never
 (Esc = later)
```

`3 never` persists `seen.import` through `writeConfigValue` (`src/config/credentials.ts:328`), following
`seen.defaultMode`'s exact precedent (`src/config/defaults.ts:154`, `hidden: true`, a config-file key, never a flag
or a variable — TD3 D-Q's ratified shape). A read-only config directory downgrades to asking again next start, with
one line in the log, exactly as D-Q's ratification specifies.

The step must survive the minsize ladder (TD4 §2.5): below 40×8 it renders the read-only wizard row
`setup · import — terminal too small; ≥ 40×8 to choose` and nothing is written.

### 5.2 The overlay

`OverlayKind` gains `'import'`; it joins `COLLAPSING` (it needs an answer, so the composer collapses to one
inactive row) and `OverlayData` gains `import?`. The reducer is `src/tui/import/reducer.ts`, the strings
`src/tui/import/lines.ts`, the Ink component `src/tui/import/Report.tsx` (all new).

**The default view is five rows and one key** (IM §5.2 [G2.5]), driven by `summarisePlan`'s `PlanGroup[]`:

```
Import — 41 to import · 9 to review · 137 skipped · 38 KiB
  memory     29   ~/.claude/CLAUDE.md, 28 notes
  rules       0
  commands    6   .claude/commands/*.md
  mcp         3   disabled on import
  review      9   3 conflicts · 4 secrets · 2 ambiguous
[y] import all 41   [Enter] expand a group   [r] review   [Esc] later
```

**The invariant that must be asserted in TUI code, not assumed.** "What `y` applies" lives in **two** places
today: `PlanGroup.applicable` (`index.ts:611`, set at `:661` as `key !== 'review' && key !== 'skipped'`) and `applicableRows`'s own
per-row `class === 'secret'` exclusion (`:683–686`). A UI that reads only the group flag would apply a credential
if one ever reached an applicable group. It cannot today — classification never emits a `secret`-class row with a
plain `create`/`append` action — but the overlay **intersects** with `applicableRows`' output per row and a unit
test asserts it, rather than trusting the group flag (§7 row 58; §15 Q9 asks the peer to confirm it is a structural
invariant).

**The overlay is built from `BlockRow[]` through `renderBlock`/`blockWidth`** (D-AO), stubbed until round 4's
`src/tui/block/**` lands (§8.4). Its width behaviour is round 4's, not a bespoke calculation: `fitRung` picks the
keys row, `blockWidth(columns)` bounds every body row.

### 5.3 The report, the apply and the undo

`src/config/imports.ts` (**new**, TUI-owned) holds the manifest reader/writer and the 17 `[import]` item builders,
re-exported by `src/tui/import/lines.ts` — the same split `src/config/credentials.ts`'s `keyEnteredText`/`savedText`
(`:36`, `:45`) already uses. Building a second copy of those strings inside `lines.ts` is exactly the drift TD4
D-V's pin inventory exists to prevent; §13 pins them as glyph-agnostic named anchors with two-glyph-set self-tests,
the pattern D-V ratified.

```
[import] applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB
[import] undo imp_… · 41 files restored · 0 modified since
[import] error: could not write <path>: EACCES (40 of 41 applied) — jevcode import --resume imp_… continues
```

**Apply is idle-only** (`availableDuringTask: 'idle'`), so the refusal string is generated for free by
`availabilityError` (`registry.ts:600`): `error: /import runs when the run is idle; Esc pauses first`. Because
apply can never run while a run is live, `/import` can never race a live prompt build — which makes IM row 94's
"pin the matched rule set at run start" a `/memory reload` concern only (§15 Q10 asks the peer to confirm).

**The tolerant manifest reader.** A `v: 0` manifest is upgraded **in memory** and never rewritten until the next
successful apply (IM row 70). There is no existing analogue to copy verbatim; the structural pattern to reuse is
`src/config/credentials.ts`'s tolerant JSON reads, not a bespoke upgrade path.

### 5.4 The `redact` seam, and one gap filed back

`PlanImportOptions.redact?` (`src/import/index.ts:209`) must be `createRedactor(<configured secrets>).redact`
(`src/core/redact.ts:93`), wired from `src/config/credentials.ts`'s loaded secret set. **Two corrections to the
task brief's framing, both confirmed by the peer** (`CD §E` items 1–2):

1. `detectSecrets` runs all 15 families unconditionally; the caller's `redact` is **only** the exact layer for
   configured secrets that match no family. Passing `patternRedact` there is useless, not harmful.
2. The runtime Jev question key for group I is the **ordinal** `secret_<i>` (`src/import/questions.ts:136`,
   `src/import/plan.ts:1119`), with the content-keyed `secretCandidateId(itemId, dotted)` as a separate lookup key
   (`plan.ts:1108`). That split exists to prevent a counter-restart bug that could demote a real credential
   ("review defect 5", comment at `plan.ts:1100–1106`). **Round 5 documents it, does not "fix" it.**

**New, filed to the harness (§8 REQUEST R7).** `renderReport` and `renderPlanJson` (`src/import/report.ts:162`,
`:283`) call `redactSecrets(text)` with **no second argument** (`:273`, `:295`), so `report.md` and `plan.json`
never receive the caller's exact layer that `discover.ts` and `index.ts:331` do thread through. The report is what
`--plain` prints and what a human reads before pressing `y`; it is the wrong place to under-redact relative to what
a Jev request already gets. No TUI-side workaround exists — `renderReport`'s signature has no seam.

### 5.5 `/import` and `/memory`, and the CLI twin (D-AO, D-AP)

Two new top-level rows, both `category: 'config'` (the member already exists at `registry.ts:45`):

| Command | Aliases | Usage | Availability |
| --- | --- | --- | --- |
| `/import` | `imp` | `/import [--dry-run] [<source>]` | `idle` |
| `/memory` | `mem` | `/memory [list\|show\|add\|forget\|reload] [<text>]` | `any` |

`BY_NAME` (`src/tui/commands/registry.ts:557–564` — verified; the draft's `:556–563` was off by one, §14.2 #25) is
a flat map built once from `name` + every alias; two rows append with no
structural change, and `POPULAR` (`:86`, 16 entries) is unchanged, so neither displaces a popular row.

**`memory.enabled` stays one switch** (D-AP), default `true`, negated by `--no-memory` through the `negateEnv`
idiom `ui.history` already uses (`src/config/defaults.ts:168`). Codex CLI splits memory into a read switch and a
write switch ([developers.openai.com/codex/config-advanced](https://developers.openai.com/codex/config-advanced))
because its memory is written **continuously** by background session summarisation, so "stop writing but keep
reading" is a real operator need. JevCode writes memory **once**, at apply, and again only via `/memory
add`/`reload`; there is no continuous writer to gate separately. The reasoning trail goes in `docs/IMPORT.md` so a
future "auto-summarise a session into memory" feature does not have to rediscover it.

**The `[project]` shadowing case.** `resolveCommand` consults `findCommand` first, so a project command literally
named `import` or `memory` (`.jevcode/commands/import.md`) is unreachable by name. `registry.test.ts` and
`project.test.ts` each get a case for this specific shadowing, and the palette shows the shadowed row tagged
`[project]` rather than hiding it (§7 row 60).

**`jevcode import`** — `Command` gains `'import'` (`src/cli/args.ts:19`), `src/cli/import.ts` is new. Flags:
`--dry-run` · `--yes` · `--scope user|project|both` · `--source <id>` · `--resume <importId>` ·
`--undo <importId>` · `--json` · `--plain`. Exit codes follow `EXIT_CODES`. The five twins are IM §5.6/§5.7's:
`--plain` numbered (`Enter selection (1-N):`), `--screen-reader` numbered with counts as words, `--ascii` through
`glyphs.ts:223`'s `asciiTwins` map (code-generated strings only, never user text), pipe/`--no-input` (dry run only,
one summary line), `--json` (one `ImportPlan`, no prose).

**`--yes` never applies a credential row.** It calls `applicableRows` (`index.ts:680`) and nothing else.

### 5.6 What the peers do, and why JevCode is the only one with a review step

- **opencode** does not import at all — it reads the other tool's file **in place**: "Project rules use
  `CLAUDE.md` (if no `AGENTS.md` exists)" ([opencode.ai/docs/rules](https://opencode.ai/docs/rules/)). No copy, no
  redaction, no review — and no way to normalise a format or to notice a secret nobody classified.
- **Claude Code**'s `/memory` opens the memory files for editing and lists their locations — a direct editor, not
  an importer ([support.claude.com cheatsheet](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet)).
  JevCode's own `/memory` (`list`/`show`/`add`/`forget`/`reload`) is deliberately the same verb for the same rough
  job; the naming parity is intentional and low-risk.
- **Cursor** moved from `.cursorrules` to `.cursor/rules/*.mdc` and now also reads `AGENTS.md` natively — with no
  in-product migration tool; the guidance is a manual rewrite.
- **Codex CLI** keeps `AGENTS.md` plus a separate `~/.codex/memories/` directory, gated by two switches (§5.5).

**Conclusion for scope:** every peer is simpler because it either reads the foreign file directly or asks the human
to migrate by hand. JevCode's copy-with-review pipeline is the only one that can redact, normalise and undo — which
is a reason to keep the "groups first, one key" overlay as tight as IM designed it, not a reason to add surface.

### 5.7 Frames

**F-56. the import overlay at 80×24 (D 10), default view.**
```
──────────────────────────────────────────────────────────────────────────────
 Import — 41 to import · 9 to review · 137 skipped · 38 KiB
   memory     29   ~/.claude/CLAUDE.md, 28 notes
   rules       0
   commands    6   .claude/commands/*.md
   mcp         3   disabled on import
   review      9   3 conflicts · 4 secrets · 2 ambiguous
 [y] import all 41   [Enter] expand a group   [r] review   [Esc] later
──────────────────────────────────────────────────────────────────────────────
```

**F-57. the wizard step at 40×20 — the narrow rung.**
```
────────────────────────────────────────
 setup · import
 found claude-code (43 notes)
 1 import  2 later  3 never
────────────────────────────────────────
```

### 5.8 Behaviour at 40, 80 and 120 columns

| Surface | 40 | 80 | 120 |
| --- | --- | --- | --- |
| overlay head | `Import — 41 · 9 · 137` | full | full + `38 KiB` |
| group row | `memory  29` | + the source hint | + the full source list |
| keys row | `y all · Enter open · Esc` | full | full |
| wizard step | 3 rows, abbreviated | 3 rows | 3 rows |
| `[import]` items | wrapped at the 10-cell gutter, dim continuation label | one row | one row |

---

## 6. The provider and model picker, and key setup — "every provider key selectable with search"

### 6.0 The backend is finished and unused

`src/models/index.ts:1–42` is a facade whose docblock is literally a numbered call order **for a picker**:
`instantCatalogue()` for the zero-I/O first frame → `catalogue.load({keys})` behind it → `rankModels()` on every
keystroke → `modelSummary()`/`sourceLabel()`/`errorLabel()` for rows → `recommend()` for the empty query →
`keyEnvNames()`/`verifyProvider()` for key setup. **`grep -rln "models/index.js\|models/list.js\|models/search.js"
src/cli src/tui` returns zero matches.** Nothing in the TUI-owned tree imports any of it.

| Built | Where |
| --- | --- |
| `ProviderId` (7 members), `PROVIDER_IDS` (display/tie-break order), `PROVIDER_KEY_ENV` (per-provider env names in lookup order, JevCode's own first) | `src/provider/ids.ts:18`, `:25`, `:36–44` — 54 lines, **zero imports**, the only provider module its own docblock allows on the argv path |
| seven `ProviderSpec` rows with `create()`, `listModels()`, `keyEnv`, `baseUrl`, `defaultModel`, `docsUrl`, capability flags, backed by seven HTTP clients | `src/provider/registry.ts:174–256` |
| `instantCatalogue(providers)` — zero I/O, never empty, the bundled snapshot | `src/models/list.ts:284` |
| `listModels`/`loadCatalogue` — network → 24 h disk cache (any age on failure) → bundled snapshot, in parallel per provider, never throws, never empty | `src/models/list.ts` |
| `rankModels`/`matchModel`/`findModel`/`nearMisses` — pure, deterministic, exact > prefix > word-start > subsequence | `src/models/search.ts` |
| `verifyProvider`/`verifyProviders` — one **free** catalogue GET per provider, no generation, redacted by construction | `src/models/verify.ts:37` |
| `modelSummary`/`sourceLabel`/`errorLabel`/`catalogueSummary` — plain strings, no Ink, no colour | `src/models/format.ts` |
| `ModelsError.kind` — `no_key \| auth \| rate_limit \| http \| network \| invalid` | `src/models/types.ts` |

### 6.1 The two-provider wall, and the one change that removes it (D-AP)

`ProviderName` (`src/core/types.ts:649`) is `'anthropic' | 'openrouter' | 'mock'`; `GeneratorConfig.provider`
(`:2005`) is `'anthropic' | 'openrouter'`; and `src/config/validate.ts:161` throws
`one of anthropic|openrouter` for anything else. `src/provider/registry.ts:16–19`'s own CONTRACT NOTE says core
owns those two unions and that widening them "makes `createProvider()` return exactly a core `Provider` with no
other change here". §8 item 6 is that widening, plus deleting the two-name check in favour of
`isProviderId(provider)` (`src/provider/ids.ts`).

### 6.2 The first-frame rule, stated as code

**The rule, stated once for all four peer trees (§2.1 rules 3a and 6; §14.2 #14, #35).** No module reachable from
`src/cli/main.tsx`'s argv path or the first frame may hold a **static, value-bearing** import of
`src/provider/registry.ts`, `src/models/**` (other than the zero-import modules below), `src/coordination/**`,
`src/import/**` or `src/orchestrate/**`. Two mechanisms, and only two:

1. **`import type`** for every type. It erases, so `AgentRow`, `Fold`, `LedgerHandle`, `ImportPlan`, `ModelInfo`
   and `SessionActivity` cost nothing.
2. **`await import()`** for every value, inside a step that provably runs after `renderer.firstFrame()` — the shape
   `defaultEngineFactory` already uses (`src/cli/session.ts:776–778`).

**Two zero-import exceptions, verified by reading the files:**

- `src/provider/ids.ts` — 54 lines, **zero imports**, pure data.
- `allStaticModels()` / `staticModels()` (`src/models/static.ts:220`) — **zero imports**, synchronous, the bundled
  snapshot.

**`instantCatalogue()` is _not_ one of them, and the earlier draft was wrong to name it (§14.2 #35).** It lives at
`src/models/list.ts:284`, and `list.ts:16–25` statically imports `../errors.js`, `../provider/sse.js`,
`../core/redact.js`, `./http.js`, `./cache.js`, `./providers.js` and `./parse.js` — and `./providers.js` in turn
imports `../provider/openrouter.js`. Naming it as the exception to "no `models/list.js`" contradicted the rule.
**The picker's first paint therefore reads `allStaticModels()` from `src/models/static.ts`** — the same rows
`instantCatalogue` returns, from the module that actually has no imports — and switches to `instantCatalogue()` /
`loadCatalogue()` behind the first `await import('../../models/index.js')`, after `run:ready`. Rows are replaced in
place as each provider's `listModels` promise settles. A picker that awaits `loadCatalogue()` before its first
paint fails the first-frame gate.

§11 gate **G-R5-1** makes this executable: the existing `JEVCODE_ASSERT_NO_NETWORK` probe plus an import-graph
assertion that `src/cli/main.tsx`'s **transitive static** imports contain none of `provider/registry.js`,
`provider/openrouter.js`, `models/list.js`, `models/providers.js`, `models/index.js`, `coordination/index.js`,
`coordination/ledger.js`, `import/index.js` or `orchestrate/index.js`. The assertion is over the *static* graph, so
a `await import()` inside a function body passes by construction.

### 6.3 The eight hardcoded two-provider tables (fix regardless of D-AP)

Each of these re-declares, rather than imports, the provider set. None of them imports `provider/ids.ts`. This is
the same drift `src/models/providers.ts` already fixed once for itself by importing and re-exporting `ids.ts`.

| # | File:line | What it hardcodes | The fix |
| --- | --- | --- | --- |
| 1 | `src/config/resolve.ts:89` | a private `PROVIDER_KEY_ENV` with two entries | import `provider/ids.ts`'s 7-entry, multi-name form — **this is a live bug**: `gemini`'s `GOOGLE_API_KEY` and `meta`'s `MODEL_API_KEY` fallbacks are missing today |
| 2 | `src/config/defaults.ts:67` | `BASE_URLS: Readonly<Record<'anthropic' \| 'openrouter', string>>` | **not** `providerSpec(id).baseUrl` — see the box below. Import `PROVIDER_BASE_URL` from `provider/ids.ts` (§8.2 **R14**), TUI-side fallback `src/config/provider-tables.ts` |
| 3 | `src/config/credentials.ts:235` | `CredentialsPatch.provider?: 'anthropic' \| 'openrouter'` | `ProviderId` |
| 4 | `src/tui/onboarding/reducer.ts:22` | `WizardProvider` + `KEY_PREFIXES` | **stays two-member by D-AR**; documented, not widened |
| 5 | `src/tui/onboarding/lines.ts:39,41` | `PROVIDER_ENV` / `PROVIDER_DISPLAY` | `PROVIDER_ENV` → `keyEnvNames` (already in `provider/ids.ts:53`, safe). `PROVIDER_DISPLAY` → **not** `providerDisplayName` — same box. Import `PROVIDER_DISPLAY_NAME` from `provider/ids.ts` (R14) |
| 6 | `src/tui/commands/registry.ts:357` | `/provider`'s `ArgSpec.values: ['anthropic','openrouter']` | `[...PROVIDER_IDS]` — safe on the first-frame path, `ids.ts` has zero imports |
| 7 | `src/tui/commands/dispatch.ts:59` | `{ kind: 'provider'; provider: 'anthropic' \| 'openrouter' \| null }` | `ProviderId \| null` |
| 8 | `src/cli/session.ts:1818` | inline `providerOfConfig(config) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'` | `keyEnvNames(providerOfConfig(config))[0]` |

> **The prescribed fix for rows 2 and 5 put the provider HTTP stack on the first-frame path (§14.2 #5).**
> `providerSpec` and `providerDisplayName` are both in `src/models/providers.ts` (`:178`, `:183`), and that module
> statically imports `../provider/openrouter.js` at **`:23`**. `src/config/defaults.ts` today imports only
> `node:path` and two type-only modules, and it is imported by `src/cli/args.ts` (**the argv path**) and by
> `src/tui/{App.tsx, status/lines.ts, commands/registry.ts, plain.ts, useEngine.tsx, onboarding/lines.ts,
> onboarding/reducer.ts, pane/model.ts}`. `src/tui/onboarding/lines.ts` is likewise a first-frame module.
> `src/models/providers.ts:28–31` states the rule the fix would have broken, verbatim: "The ids and the key env
> names live in `provider/ids.ts` (zero imports, **so the config layer can read them on the first-frame path
> without loading this module's catalogue**)." The fix would also have failed **G-R5-1**, a gate this same
> document defines.
>
> **The correction.** Base URLs and display names are **pure data**, exactly like `PROVIDER_KEY_ENV`. They move
> **into `src/provider/ids.ts`** as `PROVIDER_BASE_URL: Readonly<Record<ProviderId, string>>` and
> `PROVIDER_DISPLAY_NAME: Readonly<Record<ProviderId, string>>`, and both `src/config/defaults.ts` and
> `src/models/providers.ts` import them from there — precisely how `keyEnvNames` already works (`ids.ts:53`,
> re-exported by `providers.ts:33`). `src/provider/**` is read-only for round 5, so this is §8.2 **R14**, a
> harness request. **Fallback if R14 slips:** a zero-import TUI-owned `src/config/provider-tables.ts` holding the
> two tables, with an import-gate test mirroring `ids.ts`'s, deleted when R14 lands. Either way the rule holds:
> `models/providers.js` never appears in `src/cli/main.tsx`'s static graph, and G-R5-1 now names it and
> `provider/openrouter.js` explicitly.

**Which rows land when (§14.2 #8).** An earlier draft said "rows 1, 2, 3, 5, 6, 7 and 8 land as one small commit
in wave 1" and §9.3 constraint (f) repeated it — but five of those seven live in files whose §9.2 owner lands them
as a **single end-of-wave W4 PR belonging to a different slot**, so one W1 commit was impossible. The split:

| Rows | Files | Who lands them | Wave |
| --- | --- | --- | --- |
| 3 (`credentials.ts:235` → `ProviderId`), 4 (documented, not widened) | R5-6's own files | **R5-6** | **W1** |
| the new `src/tui/models/**` consumers of `PROVIDER_IDS` / `keyEnvNames` | R5-6's own new files | **R5-6** | **W1** |
| 5 (`onboarding/lines.ts:39,41`) | R5-5's file (§9.1 fix, §14.2 #49) | **R5-5**, R5-6's hunk verbatim | **W3** |
| 1 (`config/resolve.ts:89`), 2 (`config/defaults.ts:67`) | R5-3's files | **R5-3**, R5-6's hunk verbatim | **W4** |
| 6 (`registry.ts:357`) | R5-2's file | **R5-2**, R5-6's hunk verbatim | **W4** |
| 7 (`dispatch.ts:59`) | R5-2's own file | **R5-2** | **W2** |
| 8 (`session.ts:1818`) | R5-1's file | **R5-1**, R5-6's hunk verbatim (§9.2 previously attributed this to R5-3 — corrected) | **W4** |

Every row is **behaviour-neutral with two providers configured**, and all of them precede the R9 widening
(§9.3 constraint (f), restated).

### 6.4 `/model` — a dedicated picker, not a palette argument (D-AQ)

`/model [id]` today (`registry.ts:343–352`) sets `pending.model = id` **verbatim, with no lookup and no
validation**, and prints one heuristic warning (`src/cli/session.ts:3073`). Round 5:

- **`/model` with no argument opens a dedicated picker** in the **pane slot**, filtered by the live composer text —
  exactly `/resume`'s shape, not the eight-row command palette. **The mechanism, pinned (§14.2 #13):** `/resume`'s
  picker is **not an overlay** in this codebase. It is a separate reducer — `useReducer(pickerReducer,
  INITIAL_PICKER)` (`src/tui/App.tsx:626`), dispatched as `{ type: 'picker'; open: PickerOpen }` (`:279`, with
  `PickerOpen` at `:255`), rendered into the pane slot at `PICKER_PANE_WANT = 12` (`src/tui/Picker.tsx:163`,
  consumed at `App.tsx:2042`; `src/tui/layout.ts:94`'s `paneWant` comment reads "12 (full / picker)"), with its
  console title from `pickerConsoleTitle` (`src/tui/Console.tsx:51`). `OverlayKind` (`src/tui/layout.ts:52`) has
  **no picker member at all**. So the model picker widens **`PickerKind`** — `pickerConsoleTitle(kind: 'sessions'
  | 'rewind')` gains `'models'`, `PickerOpen` gains the models arm, `pickerReducer` gains its rows — and
  **`'models'` is deleted from §8.1 item 10's `OverlayKind` list and from §9.2's `layout.ts` row**. `App.tsx`,
  `Picker.tsx` and `Console.tsx` get §9.2 owner rows with R5-6's hunks verbatim. TD4 §4.2's
  `PaletteNavState` reads a compile-time `spec.args[0].values`; `/mode` has 4 values and `BUDGET_SETTINGS` has 6.
  Forcing 500+ catalogue rows with a background refresh and a provenance row per provider through that machinery
  needs a parallel async story the synchronous `paletteRows` has nowhere to hang.
- **`/model <id>` typed directly** stays `kind: 'text'` and is now **checked** at dispatch through `findModel`,
  with `nearMisses(id, models, 3)` (`src/models/search.ts`) behind the failure. **A check, not a gate
  (§14.2 #46).** Today `src/cli/session.ts:3071` sets `pending.model = id` verbatim with only a soft shape
  warning; turning that into a refusal is a **regression with no escape hatch** — offline with no cache, before the
  catalogue settles, or for any model newer than the bundled snapshot, a perfectly valid id would be refused where
  it is accepted today. So:
  - `models` is the **union of the loaded catalogue and `allStaticModels()`'s snapshot**, never one of them.
  - A miss is a **refusal only when the catalogue has settled live** (`sourceLabel(result, now)` is `live` or
    `cached …` for every configured provider):
    `no model named <id> — did you mean <id1>, <id2> or <id3>? (/model to browse)` (S104).
  - A miss while any provider is still loading, or while every row came from the `bundled snapshot`, is a
    **warning and the value is set**: `model <id> pending (next run) — not in the catalogue yet (bundled
    snapshot); /model browses once it loads` (S104a). §7 row 100 covers it.
- **Enter picks and pends for the next run** (today's semantics, unchanged). Claude Code's picker forks Enter
  (save as default) from `s` (session only)
  ([code.claude.com/docs/en/model-config](https://code.claude.com/docs/en/model-config)); JevCode already has a
  third, narrower semantics — "pending for the next run only" — and `s` is **reserved, not bound**, with §15 Q11
  asking the owner whether a save-as-default key is wanted.
- **No `Ctrl+L`.** It is already `global:repaint` in this product (`src/tui/keys/bindings.ts:70`) and is
  clear-screen in aider, Qwen and Cline. Crush and Pi bind it to a model picker; JevCode does not. D-X's whole
  point is that every command, including `/model`, is one `/` + Enter-cycle away without a dedicated chord.

**Row content is composed, never truncated.** `modelSummary` (`src/models/format.ts:40`) produces
`z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning`,
but `contextSummary` (`src/models/format.ts:30`), `formatPricing` and `capabilitySummary` (`format.ts:23`) are
separately exported **precisely so a narrow render drops parts instead of cutting mid-row** — re-exported at
`src/models/index.ts:170` and `:172` (the draft's `:148–160` is the `./pricing.js` re-export block, which carries
`formatPricing` but neither of the other two — §14.2 #24). The drop order is: capabilities →
output window → context window → provider name, leaving `id · $in/$out` at 40 columns.

**Provenance and failures are rows, never a blank state.** `sourceLabel(result, now)` gives `live` /
`cached 3 h ago` / `bundled snapshot`; `errorLabel(provider, error)` gives
`Google Gemini: no API key — set GEMINI_API_KEY` / `<Provider>: key rejected (401)` /
`<Provider>: rate limited — showing the last list` / `<Provider>: offline — showing the last list`. A provider
with no key still shows its cached/static rows, **dimmed, with the reason** — never hidden (OpenRouter needs no
key to list at all).

### 6.5 `/provider` and key setup

`/provider [<id>]`'s `ArgSpec.values` becomes `[...PROVIDER_IDS]` (seven) and its `DispatchResult` discriminant
widens to `ProviderId | null`. The wizard stays binary (D-AR); a sixth provider is reached by:

```
/provider openai            → pends; if no key resolves, offers  /login openai
jevcode login --provider openai [--key-stdin]
```

**Verification is the free catalogue GET, never the priced probe** (D-AR). `verifyProvider(spec, apiKey, deps, opts)`
(`src/models/verify.ts:37`) is free, provider-agnostic across all seven, redacted by construction and returns
`{ ok, latencyMs, via, modelCount?, error? }`. The wizard's existing `verifyForWizard` path
(`src/cli/session.ts:1781` → `src/cli/login.ts:84`'s `VERIFY_PROBE_STATE = { message: 'hi' }`)
verifies the **decider**, which is a different question and costs money. New outcome strings, parallel to
`verifiedGeneratorText`/`verificationFailedText` (`src/tui/onboarding/lines.ts:242`, `:493`) but sourced from
`VerifyResult`:

```
<provider> key verified — <n> models
<provider> key rejected (401)
<provider>: rate limited — try again
```

**Ctrl-C during a verify or a refresh** reuses the wizard's existing shape
(`src/tui/onboarding/Wizard.tsx:141`'s `verifyAbort` ref and `:180`'s per-verify `new AbortController()`): one
controller per request, cancel aborts only the in-flight call, the key already typed is kept. Both `verifyProvider` and `listModels` already accept `opts.signal`.

**Credentials stay single-slot** (D-AR): `CredentialsFile` keeps `apiKey` + `provider`
(`src/config/credentials.ts:115–123`, `CREDENTIAL_KEYS = ['apiKey','jevApiKey']` at `:26`). A power user who wants
several providers live at once exports several env vars, which `PROVIDER_KEY_ENV`'s per-provider lookup already
serves. §15 Q12 flags the revisit condition.

**One redaction gap, filed not fixed (§8 REQUEST R8).** `FORMAT_PATTERNS` (`src/core/redact.ts:68–75`,
harness-owned) has prefix families for OpenRouter (`sk-or-v1-`), Anthropic (`sk-ant-`), OpenAI (`sk-`/`sk-proj-`)
and Google (`AIza`) — and **none for xAI, Fireworks or Meta**. A pasted-but-unsaved key of those three shapes typed
into the ordinary chat composer is not caught by the pattern layer (the composer's secret gate,
`src/tui/secrets/gate-lines.ts`, reads the same families). The exact layer still catches it once saved via
`addSecret`.

### 6.6 `jevcode models` — the CLI twin

`Command` gains `'models'`; `src/cli/models.ts` is new, over an injected I/O seam like `src/cli/sessions.ts`, and
starts no engine.

| Verb | Behaviour |
| --- | --- |
| `jevcode models list [--provider <id>]` | the catalogue, snapshot-first, one row per model through `modelSummary` |
| `jevcode models search <query>` | `rankModels` over the loaded catalogue — the shape Aider's `--list-models <substring>` has had for years ([aider.chat/docs/config/api-keys.html](https://aider.chat/docs/config/api-keys.html)) |
| `jevcode models refresh [--provider <id>]` | an explicit, user-initiated fetch; **never run unattended** (§15 Q13) |
| `--json` | the `ListResult`/`CatalogueLoad` shape serialised as-is: `{ provider, models, source, fetchedAt, stale, error }` per provider — never a second row model |

### 6.7 Frames

**F-58. the `/model` picker at 120×40, composer text `glm` (D 12).**
```
── models · 512 of 7 providers · by relevance ─────── ↑↓ Enter Tab Esc ──────────
 › glm
 ▸ z-ai/glm-5.3-flash    OpenRouter  1.3M ctx  $0.15/M in  $0.50/M out  tools json
   z-ai/glm-5.3          OpenRouter  1.3M ctx  $0.60/M in  $2.00/M out  tools json
   z-ai/glm-5.2-air      OpenRouter  200k ctx  $0.05/M in  $0.20/M out  tools
 OpenRouter live · Anthropic cached 3 h ago · Google Gemini: no key — GEMINI_API_KEY
──────────────────────────────────────────────────────────────────────────────────
```

**F-59. the same picker at 40 columns — id and price only.**
```
── models · 512 ── ↑↓ Enter Esc ────────
 › glm
 ▸ z-ai/glm-5.3-flash  $0.15/$0.50
   z-ai/glm-5.3        $0.60/$2.00
   z-ai/glm-5.2-air    $0.05/$0.20
 OpenRouter live · 2 providers no key
────────────────────────────────────────
```

### 6.8 Behaviour at 40, 80 and 120 columns

| Surface | 40 | 80 | 120 |
| --- | --- | --- | --- |
| picker row | `id · $in/$out` | + provider + context window | whole `modelSummary` |
| provenance row | `OpenRouter live · 2 providers no key` | two providers named | every provider named |
| `--plain` twin | numbered list, `models (1-40 of 512) — type a number, "more", or a query, then Enter`, prompt `pick 1-40, or type a query > ` for exactly one turn | same | same |
| screen reader | `models: 3 of 40 · z-ai/glm-5.3-flash · OpenRouter · $0.15/M in · Enter picks, Tab narrows, Esc closes`, coalesced ≤ 1 per 400 ms | same | same |

---

## 7. The edge-case matrix — fault → behaviour → evidence → test

**One hundred and two numbered rows** — the original ninety, the ten the review added as §7.9 (91–100), and two
the brief named that belong in earlier subsections (12a, 22a). **Evidence** is a `file:line` in
this worktree or a design section; **test** names the file §10 assigns to the slot that owns it. A row marked
**GAP** has no handling today and round 5 creates it.

### 7.1 Multi-session awareness (rows 1–20)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 1 | A second JevCode starts in this workspace | the status zone gains `⇄ 1 live` within one fold poll; no frame blocks, no clear | `Fold.liveness` `src/coordination/types.ts:327–366`; §2.2 | `status-peers.test.ts`; `who.pty.test.ts` |
| 2 | The fold is not open yet (before `firstFrame()`) | every coordination surface renders its empty state; the zone is absent, never a spinner | §2.1 rule 3; `types.ts:470` doc comment | `first-frame.ts` gate; `status-peers.test.ts` empty case |
| 3 | A session crashed (process gone, lock stale) | its row shows `◌ stale (last beat 4 m ago) · crashed during step 8 (propose)`; a `/resume` takes it with **no** takeover prompt | `isPidAlive` `src/session/lock.ts:27`; `lockReplaceVerdict` dead-pid branch `src/coordination/records.ts:829`; `Fold.gone` | `records.test.ts`; `who.test.ts` crashed fixture |
| 4 | A process is alive but frozen (heartbeat stopped) | `● … (no beat 4 m — hung?)` — alive is not live; `isLive` reads arrival/env, not pid | `isLive(record, now, arrival, env, origin)` `records.ts:714` (5 params, 4th is `env`) | `records.test.ts` frozen-heartbeat case |
| 5 | Clock skew between two devices | rank never trusts wall clock above epoch: `compareClaim` is epoch desc → deviceId asc → runId asc → **at asc** → pid asc; `at` is fourth | `src/coordination/claims.ts:85` | `claims.test.ts` property: a skewed `at` never flips a decision the first three keys settled |
| 6 | A device is skewed > 300 s | the row shows `⚠ skewed <n>s`, display only; `skewMs` is never a liveness input | `SessionActivity.skewMs` `types.ts:447` (comment: "display only — NEVER a liveness input") | `who.test.ts` |
| 7 | Same repo opened through two paths (symlink, bind mount) | `Fold.cloned` distinguishes a second clone from a path alias; the TUI keys off `origins`, never re-derives `sameDevice` | `Fold.cloned` / `.origins` `types.ts:327–366`; §2.1 rule 4 | `fold.test.ts` two-path-one-inode case |
| 8 | Same repo through two git worktrees | both rows show under one repo identity, not merged into one | `SessionActivity.sameRepo` / `sameBranch` `types.ts:454–455` | `sessions-target.test.ts` two-worktree fixture |
| 9 | Two runs in one checkout with diverging `repoKey` | both stay mutually visible through the dual-directory lease write; no TUI text calls "the lease directory" singular | CO §9.2; `Fold.leases` | `fold.test.ts` |
| 10 | An offline device that never synced | shown as `? unknown (not synced yet)`, distinct from "0 live"; absence ≠ liveness false | `Liveness` union; `SessionActivity.syncLagMs` `types.ts:453` | `watch.test.ts`; `who.test.ts` |
| 11 | A device past `MAX_DEVICES` (16) in the fold | its rows are not in the fold and `/who --all` says so: `<n> devices past the fold cap — jevcode sessions gc lists them` | CO §12.0.5; `Fold.skipped` | `who.test.ts` |
| 12 | A bench heartbeat | a **different row shape**, not a variant: `● mbp  bench glm-vs-jev  12/30 tasks live 4 · lanes 8` | `SessionActivity.kind: 'run' \| 'bench'` `types.ts:441` | `who.test.ts` bench fixture |
| 13 | A cloned device (`Fold.cloned`) | its row renders, flagged `⚠ cloned`, with every gated verb **disabled and explained**; never hidden | `Fold.cloned`; §2.9 | `who.test.ts`; `mailbox.test.ts` |
| 14 | `sessions gc --device <label>` past the fold cap | the label resolves by **walking the disk** to `MAX_GC_DEVICES` (1,024), never through `fold.devices` (capped at 16) | CO §12.0.5; §2.10 | `sessions-gc.test.ts` |
| 15 | A verified peer outranks this claim | exit 2, one line: `error: run <id> is also live on <label> (claim 4 supersedes 3) — stopped to avoid a double writer` | `ForkVerdict.role`/`.verified` `claims.ts:222`, `:251` | `engine-takeover.test.ts` |
| 16 | An **unverified** beat outranks this claim | a flag and a row, **never a stop**: `run <id> also appears live on mbp (unverified) — [c] continue here  [q] stop` | `unverifiedFork` `claims.ts:252`; §2.1 rule 5 | `records.test.ts` forged-beat case |
| 17 | A forged record placed in the local subtree | "same device" is the **read location** (`Fold.origins`), never `record.deviceId === self.deviceId`; the `hostKey`/`bootId` checks still gate auto-apply | §2.1 rule 4; CO §5.4 rules 4–5 | `mailbox.test.ts` forged-local case |
| 18 | A message from an unpaired device | rendered with `(unverified)`, never auto-applied; the ack is `refused` with `detail60: 'device unpaired'` | CO §5.5; §2.9 | `mailbox.test.ts` |
| 19 | A device unpaired while this session runs | the exact sentence, not a silent continue: `unpaired mbp — it can no longer steer, stop, resume, end or import your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.` | CO §10.3; §2.10 | `mailbox.test.ts` |
| 20 | Two machines share one device id | `device id <id8> is also live on another machine — run 'jevcode sessions pair --rotate' to invalidate the shared key`; and, with no machine id, `machine id unavailable — two machines sharing this home would share one device id` | CO §10.3 | `ledger.test.ts` |

### 7.2 Pause, resume, end, crash, cross-device (rows 21–34)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 21 | Pause at a step boundary (default) | the step commits whole, then the loop top stops: `pausing · step 8 commits first (propose, 41 s, ~40 s p50 left) · Esc Esc aborts · Ctrl-X Ctrl-P pauses now` | `PauseOptions.at` `src/core/types.ts:1583`; `PausePointReason 'step'` `:1544` | `pause.test.ts` |
| 22 | Pause **now** mid-stage | the stage in flight is discarded; the proposal and arrived samples are cached: `paused now at step 8 (propose): proposal kept — /resume replays it` | `PausePointReason 'now'` `:1545`; `PausePoint.resumableAt`/`.replayable` `:1560`, `:1566` | `pause.test.ts` now-during-propose |
| 23 | Pause **now** landing during `execute` | execute finishes, judge is skipped, the step commits; never a kill | `PausePointReason 'now-after-execute'` `:1546` | `pause.test.ts` now-during-execute |
| 24 | Pause while a blocking pane is open | the pane wakes with `'pause'`; the resume card says `paused at the <kind> pane after step 7 — /resume retries it` | `BlockingAnswer 'pause'` `:1226`; `PausePointReason 'pane'` `:1547` | `blocking.test.ts` |
| 25 | Pause while the checkpoint write is degraded | `checkpoint degraded: <code> on state.json — not resumable (exit 3)`; the epilogue never advertises a resume that cannot work | TD4 §7.2 (landed decision); `PausePoint` | `epilogue.test.ts`; `session.test.ts` |
| 26 | `/resume` after a local crash, no foreign claim | the same path, **zero** takeover prompt, **zero** epoch bump | `lockReplaceVerdict` dead-pid branch `records.ts:829` | `records.test.ts`; `engine-takeover.test.ts` |
| 27 | `/resume` with a qualified foreign claim | refused once, with the escape named: `taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it` | `claimRefusal` `claims.ts:265`; §2.8 | `engine-takeover.test.ts` |
| 28 | `/resume` with an **unqualified** foreign claim | never refused; one card line: `mbp claims 4 (unverified) — ignored; sessions pair to make it count` | `claims.ts:274` (unqualified rows skipped) | `engine-takeover.test.ts` |
| 29 | `--force-takeback` at the epoch ceiling | a stated, permanent limit, never a silent hang: `claim epochs for this run reached the bound (1e9); nothing can take it over — start a new run from this state` | `claims.ts:275` bound filter | `claims.test.ts` |
| 30 | `[r]` replay offered when targets moved | `[r]` is withheld and the reason is named: `targets changed since the proposal (store.ts by mbp@8bc0d11) — replay unavailable` | `PausePoint.replayable` `:1566` ("this AND every `targetsSha` still matches") | `picker.test.tsx` |
| 31 | Resuming an **imported** run | no `[r]`: `the paused proposal and its samples stayed on <label> — resuming starts a fresh step` | CO §7.3; the mirror carries no bodies | `picker.test.tsx` imported fixture |
| 32 | `/resume <id> --on device:<label>` | routes a message; the far device answers `[y]`/`[n]`, or spawns headless only with `coordination.remoteControl: 'allow'` | CO §7.6; §2.9 | `mailbox.test.ts`; `sessions-target.test.ts` |
| 33 | `end` after `pause`, and `pause` after `end` | idempotent both ways: the first writes `RunMeta.ended`; the second answers `already ending — /resume <id> --force reopens it` | `Engine.end?` `:1771`; `PausePoint.end` `:1578`; `RunEnded` `:1597` | `session.test.ts` `/end` cases |
| 34 | A lease conflict on a file a peer holds | the `[w]/[r]/[t]/[q]` pane (D-AF), or — if the `BlockingKind` member does not land — a `/who`-visible flag and no pane at all; **never** a silent block. The member is **not additive**: four TUI-owned exhaustive consumers gain placeholder cases in the peer's one commit (§2.11) | `BlockingAnswer` already has `'wait'`/`'worktree'` `:1226`; `BlockingKind` `:1225` (6 members); the four consumers: `status/lines.ts:284`, `blocking/lines.ts:121`, `:238`, `test/unit/tui/pane/blocking.test.ts:58` **GAP** | `blocking.test.ts` lease-conflict + land-preflight cases (skipped until R1 lands) |

### 7.3 Context and compaction (rows 35–43)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 35 | `status.context` absent — **including `llm-jev`, the default mode** | the cell simply does not render — no placeholder, no `ctx —%`; `/context` says `this run does not build a relaxed context (<mode>) — /mode jev-on builds one`. **This is a filed gap, not a correct state** (§3.1): until §8.2 R13 lands, a default install sees nothing | `contextEnabled` `src/loop/engine.ts:922` (`jev-on`/`jev-off` only); `DEFAULT_MODE = 'llm-jev'` `src/config/defaults.ts:50`; `jev-off` routes to `createGeneratorOnlyEngine` at `src/cli/session.ts:777` **GAP** | `status-ctx.test.ts`; `context.test.ts` per-mode cases incl. `llm-jev` |
| 36 | No run is live | `/context` says `no run is live — /context reports the run's prompt budget` | §3.2 | `context.test.ts` |
| 37 | Before the first prompt (`promptChars: 0`) | the live cell shows `ctx 0%` (informative); `/context` says `no prompt built yet — /context fills in at the first step` | `computeContextUsage` floors at `Math.max(1, …)`, so no divide-by-zero | `context.test.ts` |
| 38 | Resume card with no `lastPromptChars` | the `ctx` cell is **omitted, not zeroed** — deliberately different from the live cell (§2.8) | CO §7.3 step 2; `CheckpointState.lastPromptChars?` | `picker.test.tsx` |
| 39 | Resume with a summary on disk but not yet loaded | `/context` reads `CheckpointStore.readContextSummary()` itself rather than waiting for the engine's lazy re-read | `src/loop/engine.ts:3558` (atomic write); `hasContextStore` `src/checkpoint/types.ts:40` | `context.test.ts` resume fixture |
| 40 | `--ascii` / `NO_COLOR` / `TERM=dumb` and the meter's `·` | the cell substitutes `g.dot`; `formatMeter`'s literal `·` (`src/loop/context/meter.ts:112`) never reaches an ascii frame | `modeBadgeWord`'s existing idiom **`src/tui/status/lines.ts:113–114`** (`:107` is an unrelated doc comment — §14.2 #23); `GLYPHS` `src/tui/glyphs.ts:213`, `glyphSet` `:216` **GAP** | `status-ctx.test.ts` ascii twin; `twins.pty.test.ts` |
| 41 | Crossing 85 % / 95 % | the word **and** a one-time notice, not colour alone: `ctx 87% amber · /compact now` | `MeterLevel` `meter.ts:79`, thresholds `:83–84`; no `context:warn` event exists **GAP** | `status-ctx.test.ts` crossing property (one notice per threshold per run) |
| 42 | `/compact` that folds nothing | `nothing to compact — only the newest step is in history`, decided by comparing `context.compactions` either side of the synchronous call | `src/loop/engine.ts:1519–1523`, `:3556`, `:3565` | `context.test.ts` |
| 42a | **`/compact` with `context.compaction: 'off'`** | the **`off` branch is checked first** and says so: `compaction is off for this run (context.compaction) — jevcode config set context.compaction code turns it on`. Row 42's sentence would be a falsehood here — forty foldable steps may exist | `src/loop/engine.ts:1520` returns immediately with no status emit and no `compactions` change; the state is on `status().context.compaction` (`ContextUsage.compaction`, `src/core/types.ts:1669`); the setting is §3.6's own **GAP** | `context/lines.test.ts` `off` case |
| 43 | A tiny model window | `budget <N> chars — capped by the <M>-token model window`, already produced by `formatBudget` | `windowTooSmall` `types.ts:1673`; `meter.ts:99` | `context.test.ts` |

### 7.4 Concurrent git, and the agent tree (rows 44–51)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 44 | Another process holds `.git/index.lock` | a named, recoverable error, never a raw git stderr string or a hang: `git is busy (another process holds .git/index.lock) — retrying in 2 s, or /diff again` | **GAP**: `grep -n "index.lock\|EAGAIN\|EBUSY" src/workspace/gitstate.ts src/workspace/patch.ts` → nothing; the pattern to copy is `classifyDiskError`/`DiskError` in `src/checkpoint/store.ts` (D-AT) | new `workspace/patch.test.ts` `index.lock` case |
| 45 | `EAGAIN`/`EBUSY` from a git spawn | the same classification, one sentence, one retry hint | same **GAP** | same |
| 46 | Two sibling agents touch one file | the collision surfaces as row 44's named error plus the agent row's `conflicts in <path>` state | `AgentState 'conflicted'` `src/orchestrate/types.ts:37` | `agents-lines.test.ts` |
| 47 | The supervisor process crashes, children alive | children are adopted within one poll by the next session on this workspace: `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked)` | OR §4.4 **GAP** (no `AgentSupervisor` exists — fixture-only this round) | `agents-lines.test.ts` adoption fixture |
| 48 | A resumed or adopted child takes a slot | caps are checked against the **live fold**, never a persisted counter | `listSessions` `src/coordination/fold.ts:387`; §4.7 | `agents-caps.test.ts` |
| 49 | `baseSha` moved since delegation | the resume card replaces `[Enter]` with `base moved 3f9a2c1 → 9d21ee0 (2 commits by you) — [r] rebase the 3 agents · [s] stage on the old base · [f] forget` | OR §4.5 | `agents-card.test.ts` |
| 50 | Worktree gone, branch present | `[n] recreate from jevcode/<slug>` — the branch is the truth, the worktree is a cache. Branch **and** run dir gone → `dropped`, no recovery offered | OR §4.5; `AgentState 'dropped'` `types.ts:39` | `agents-card.test.ts` |
| 51 | Two children need approval at once | each review card carries `ConfirmRequest.badge = 'agent <slug>'` so nobody approves the wrong thing | §4.6; §8 item 5 **GAP** | `review.test.tsx` badge case |

### 7.5 Import (rows 52–60)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 52 | Nothing installed to import | the wizard step does not render at all; `/import` says `nothing to import — no claude-code, codex or cursor configuration found` | `probe` `src/import/index.ts:584`, `deadlineMs: 50` | `reducer.test.ts`; `import.test.ts` |
| 53 | The probe exceeds 50 ms | the step is skipped for this start; the probe never blocks the wizard | `probe`'s own deadline `:592` | `onboarding.test.ts` |
| 54 | A malformed source file | classification never throws; the row is `skip:<reason>` and the overlay renders the reason, never a stack | `docs/DECISIONS.md` (identity rules before atlas class) | `plan-scope.test.ts` (harness); `import-lines.test.ts` renders the reason |
| 55 | An oversize source that is also a credential store | the secret basename rule still fires; oversize does not pre-empt it outside the never-imported atlas classes | same decision-log entry | `import.test.ts` oversize+secret fixture |
| 56 | The source changed between plan and apply | re-verification refuses that row and names it; the rest apply | IM [G1.1]; `applyPlan` | `apply.test.ts` |
| 57 | `EACCES` mid-apply | `[import] error: could not write <path>: EACCES (40 of 41 applied) — jevcode import --resume imp_… continues` | IM row 79; `resumeImport` `index.ts:142` | `import-resume.test.ts` |
| 58 | A credential row in an "applicable" group | `y` intersects with `applicableRows`' per-row output, never trusting `PlanGroup.applicable` alone | `index.ts:611/:661` vs `:683–686`; §5.2 | `import-reducer.test.ts` invariant case |
| 59 | `Ctrl-C` during discover / apply / overlay | three different behaviours: discover aborts and keeps nothing; apply stops at the row boundary and prints the resume hint; the overlay closes and keeps the plan | IM §5.2 | `r5-import-ctrlc.pty.test.ts` |
| 60 | A project command named `import` or `memory` | the built-in wins; the shadowed row is listed in the palette tagged `[project]`, never silently unreachable | `resolveCommand` consults `findCommand` first; §5.5 | `registry.test.ts`, `project.test.ts` shadowing cases |

### 7.6 Secrets and keys (rows 61–66)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 61 | Any new frame, log line or index line | zero key bytes, ever — extended to device keys, claim HMACs and imported credentials | `assertNoKeyBytes` `test/pty/round3.pty.test.ts:54` | every new pty scenario calls it |
| 62 | A configured secret that matches no pattern family | `createRedactor(secrets).redact` substitutes it; the pattern layer alone would not | `src/core/redact.ts:93`; `detectSecrets` runs all 15 families regardless | `import/leak.test.ts` |
| 63 | `report.md` / `plan.json` | today they receive the pattern layer only, not the caller's exact layer | **GAP**: `src/import/report.ts:273`, `:295` call `redactSecrets(text)` with no second argument (§8 REQUEST R7) | `import/leak.test.ts` extended once R7 lands |
| 64 | An xAI / Fireworks / Meta key pasted into the composer | not caught by the pattern layer today | **GAP**: `FORMAT_PATTERNS` `src/core/redact.ts:68–75` has no family for those three (§8 REQUEST R8) | `redact.test.ts` once R8 lands |
| 65 | A gateway that echoes `Authorization` into its error body | every `ModelsError.message` is pre-redacted by construction; the picker renders `ModelsError`/`VerifyResult.error` fields, never a raw thrown error | `src/models/list.ts`'s own comment on the `redact` default | `models-picker.test.ts` |
| 66 | A device key on screen during pairing | the pairing phrase is shown; the 32-byte key never is | `COMMONS_KEY_BYTES` / `COMMONS_KEY_RE` `src/coordination/claims.ts:283–284` | `pair.pty.test.ts` + `assertNoKeyBytes` |

### 7.7 Provider and model picker (rows 67–78)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 67 | First run, empty cache, offline | `instantCatalogue()` paints the snapshot synchronously; the picker never awaits the network for frame 1 | `src/models/list.ts:284`; §6.2 | `models-list.test.ts` all-offline-no-cache; `first-frame.ts` gate |
| 68 | Cache older than 24 h | the stale entry is served immediately with `sourceLabel` = `cached 3 h ago`, refreshed in place | `isFresh` in `src/models/cache.ts`; `ListResult.stale` | `models-list.test.ts` stale case |
| 69 | A clock briefly set forward | a `fetchedAt` in the future counts as **not** fresh; the picker must not second-guess this | `cache.ts`'s own comment on the future-timestamp rule | `models-cache.test.ts` |
| 70 | Offline mid-session | `<Provider>: offline — showing the last list` | `errorLabel`'s `network` branch, `src/models/format.ts` | `models-picker.test.ts` |
| 71 | No key for a provider | the rows still show, **dimmed, with the reason**: `Google Gemini: no API key — set GEMINI_API_KEY`; never hidden. OpenRouter needs no key to list | `listNeedsKey`/`noKeyError` in `src/models/list.ts`; `PROVIDER_KEY_ENV` `src/provider/ids.ts:36–44` | `models-picker.test.ts` |
| 72 | A present but rejected key | `<Provider>: key rejected (401)` — distinct from "no key" | `ModelsError.kind 'auth'` | `models-picker.test.ts` |
| 73 | Rate limited mid-refresh | `<Provider>: rate limited — showing the last list`; the old rows stay on screen | `ModelsError.kind 'rate_limit'` | `models-picker.test.ts` |
| 74 | Zero providers configured | a non-throwing result with `models: []` plus one sentence: `no provider is configured — /login adds a key` | `loadCatalogue` never throws, never returns undefined | `models-list.test.ts` zero-provider case |
| 75 | A typo'd model id | `no model named <id> — did you mean <id1>, <id2> or <id3>? (/model to browse)` | `findModel` → null; `nearMisses(id, models, 3)` in `src/models/search.ts` | `models-search.test.ts` |
| 76 | OpenRouter routing variants (`:free`, `:batch`, `:nitro`) | ranked behind their standard route on the empty query (a `$0` price would otherwise sweep the top) but still found by an explicit query | `isRoutingVariant`/`compareModels` in `src/models/search.ts` | `models-search.test.ts` |
| 77 | A model whose provider has no generator adapter | before D-AP lands: shown, marked, and refused as a pending value with a reason. After D-AP: no such case | `isGeneratorProvider` in `src/models/providers.ts`; §6.1 | `models-picker.test.ts` (deleted with the constant once D-AP lands) |
| 78 | `Ctrl-C` during a verify or a refresh | one `AbortController` per request; only the in-flight call aborts; the typed key is kept | `src/tui/onboarding/Wizard.tsx:141`, `:180`; `opts.signal` on `verifyProvider`/`listModels` | `login.test.ts`; `models-picker.test.ts` |

### 7.8 Cross-cutting: twins, widths, motion, performance (rows 79–90)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 79 | `--plain` for every new row | the same content through the one formatter, never a second hand-written string | `src/tui/plain.ts`; TD4's line-identity gate | `plain.test.ts`; `r5-identity.test.ts` |
| 80 | `--json` where a CLI verb exists | one stable shape per new verb, serialising the existing type, never a re-modelled row | `sessions list --json`'s `{ sessions, skipped }` precedent | one `--json` snapshot test per new verb (§10) |
| 81 | `--ascii` / `NO_COLOR` | every new glyph substitutes through **`glyphSet({ ascii })`** — an options object, not a boolean (`src/tui/glyphs.ts:216`), with `ascii` winning over `screenReader` (§14.2 #53); colour roles drop. **Nine of them do not exist yet** and are added to `GlyphSet` by §8.1 item 10: `● ○ ◌ ⇄ ✉ ⏸ ⟳ ↻ ↪` → `* o . <> mail = ~ @ >>`. `⚠ → ✓ ✗ −` already exist. `asciiTwins()` is **injective** (`:223–232`, first entry wins), so no glyph may take two twins — the `◌` collision between S3 and S60 is resolved in §12 (§14.2 #43) | `src/tui/glyphs.ts:11` (`GlyphSet`), `:105–156` (`UNICODE`), `:213`, `:216`, `:223–232` **GAP** | `glyphs.test.ts` injectivity case; `twins.pty.test.ts` sweep extended to every round-5 string |
| 82 | Screen reader | every new card and row has a sentence form; no glyph-only row | TD4 §12's SR precedent | one SR assertion per new surface (§10) |
| 83 | Reduced motion | no animated component renders while a confirmation is pending on any of the five new surfaces | TD4 D-AA's rule | `idle-frames` `live` case extended |
| 84 | Widths 40 / 80 / 120 | no static row from a new command or card exceeds `blockWidth(columns)` | TD4 §3.1.2; §11's `block-width` gate | `commands-width.steps` extended; `r5.pty.test.ts` |
| 85 | A resize mid-picker or mid-card | re-measure, never truncate silently; the rung ladder re-selects | TD4 §2.3, §2.6 | `resize.pty.test.ts` extended with `r5-model-picker` and `r5-import-overlay` |
| 86 | The minsize floor (< 40×8) during the import wizard step | the read-only wizard row, nothing written | TD4 §2.5 (P-R6's refund) | `onboarding.test.ts` minsize case |
| 87 | First frame | still < 300 ms with zero network and zero file I/O, **and** with no `provider/registry.js` or `models/list.js` network path in `src/cli/main.tsx`'s import graph | §6.2; `JEVCODE_ASSERT_NO_NETWORK` | `first-frame.ts` + the new import-graph assertion (gate G-R5-1) |
| 88 | A fold with 200 live rows | `/who` builds in < 20 ms and the status zone in < 1 ms; neither is on the per-frame path more than once per fold change | `Fold` is maintained by its watcher; §2.2 | `who-bench.test.ts` (gate G-R5-4) |
| 89 | A 500-model catalogue and a keystroke | `rankModels` + row build p95 < 16 ms at 120 columns | `rankModels` is pure and synchronous | `composer-latency.ts` new series `model-picker` (gate G-R5-5) |
| 90 | Two slots edit `registry.ts` / `INDEX_KINDS` / `config/defaults.ts` in the same wave | one owner, one PR, at the end of the wave; the merged arrays are asserted by membership | `docs/DECISIONS.md` 2026-09-22 shared-file entry; D-AS | `registry.test.ts`, `session/index.test.ts`, `contract.test.ts` |

### 7.9 Rows the review added (rows 91–100)

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 91 | A letter typed while the resume card's expanded sub-state is open | the four card letters (`r`/`f`/`d`/`w`) resolve **only** in that sub-state; the list filter is inert and the card says `Esc returns to the list`. Outside it they are filter text, unchanged | §2.8; the picker's composer **is** its filter `src/session/picker-lines.ts:1–33`; precedence `src/tui/keys/resolve.ts:5`; `picker:delete` already owns bare `x` `src/tui/keys/bindings.ts:136`; `w` is chord-first elsewhere `resolve.ts:62` **GAP** | `picker.test.tsx` sub-state cases; `keys.test.ts` precedence case |
| 92 | A secret-shaped token in a `/tell` / `/headsup` / `/request … steer` body | gated **before** the write with the composer's `[y]` ladder: `that message looks like it contains a key — [y] send anyway  [n] edit  [Esc] cancel` | §2.9; the composer gate `src/tui/secrets/gate-lines.ts` sees submissions, **not** slash-command arguments **GAP** | `commands/dispatch.test.ts` secret-body case; `mailbox.test.ts` |
| 93 | The mailbox record itself | the body is written through `createRedactor(<configured secrets>).redact` regardless of the `[y]` answer — `[y] send anyway` sends the **redacted** text | `src/core/redact.ts:93`; `FORMAT_PATTERNS` `:68–75` is six families and misses xAI/Fireworks/Meta (§8.2 R8) **GAP** | `import/leak.test.ts` sibling: `mailbox-leak.test.ts` |
| 94 | A remote `steer` body arriving | redacted by the **receiving** session's redactor before `Engine.deliver` and before `transcript.log`; the sender's secret set is not the receiver's | `Engine.deliver?(msg)` `src/core/types.ts:1773`; §2.9 **GAP** | `mailbox.test.ts` inbound-redaction case |
| 95 | The lease holder goes `stale` while `[w] wait for it` is armed | the pane **re-renders**, never silently proceeds: `the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit`; `[w]`'s meaning changes with the card | `Liveness` `src/coordination/types.ts:403` (5 members, incl. `'stale-reused-pid'`); `Fold.leases` `:333`; §2.11 **GAP** | `blocking/lines.test.ts` stale-holder case |
| 96 | `[w] wait for it` with no end in sight | an elapsed counter and an escape on the row — `[w] waiting 2m14s — Esc gives up` — re-checked on **every fold change**, never a sleep that cannot be woken | §2.11; §1.4 promise 2 names the pane as the single exception to never-blocks **GAP** | `blocking/lines.test.ts`; `r5-pause-end.steps` |
| 97 | A lease whose holder is `gone` | **not a conflict**: the pane never opens, one `[ui]` line records it — `took a lease left by a session that is gone (mbp, 14:02)` | `Fold.gone`; §7 row 3 is the same crashed case; §1.4 promise 3 **GAP** | `blocking/lines.test.ts` gone-holder case |
| 98 | A **resume** above a context threshold already crossed | the crossing set is **per process**, so the amber/red notice fires again on the resume — a user who resumes at 90 % is told | `ContextUsage.compactions` is "over the run's life, all resumes" `src/core/types.ts:1663`; §3.1 **GAP** | `context/lines.test.ts` resume-above-threshold case |
| 99 | A key pressed while the agents tab is focused **and** the composer has text | focus is **refused** while the draft is non-empty (the `when: 'empty draft'` guard `global:paneNext` already carries, `src/tui/keys/bindings.ts:72`); `Alt+A` answers `finish or clear the line first — Alt+A then focuses the agents tab` | §4.3; `resolveKey`'s chain has no pane rung today `src/tui/keys/resolve.ts:5` **GAP** | `keys.test.ts`; `round5-agents-app.test.tsx` |
| 100 | `/model <id>` for an id the catalogue has not loaded | a **warning, not a refusal** — the value is set: `model <id> pending (next run) — not in the catalogue yet (bundled snapshot); /model browses once it loads`. A refusal only once every configured provider's `sourceLabel` is `live`/`cached` | today `src/cli/session.ts:3071` sets it verbatim with a soft shape warning; `findModel`/`nearMisses` `src/models/search.ts`; §6.4 **GAP** | `models-search.test.ts`; `session.test.ts` `/model` cases |

**Two rows the brief named that §7.1–§7.8 also gained:**

| # | Fault / situation | Required behaviour | Evidence | Test |
| ---: | --- | --- | --- | --- |
| 12a | A **bench resume** (not merely a bench heartbeat) | the resumed bench keeps its `kind: 'bench'` row shape and its `12/30 tasks` counter continues from the index, never restarting at 0; `/who` never shows two rows for one bench | `SessionActivity.kind` `src/coordination/types.ts:441`; `Heartbeat.subwork` `:145` **GAP** | `who.test.ts` bench-resume fixture |
| 22a | Pause landing **mid-LLM-round** | the round's arrived samples are kept and named: `paused now at step 8 (propose, round 2 of 3): 2 samples kept — /resume replays them`; this is the one pause shape with recoverable samples | `PausePoint.llm { goalId, round, arrived }` `src/core/types.ts:1571–1574` **GAP** | `pause.test.ts` mid-round case; `picker.test.tsx` card branch |

---

## 8. Contract 1.8 — additive, in TUI-owned blocks only; and the REQUESTS to the peer

**The number.** `src/core/types.ts:9–14` carries `1.1, 1.2, 1.2, 1.3, 1.4, 1.7`; `1.5` (orchestration) and `1.6`
(import) are reserved and unlanded. `docs/DECISIONS.md:1034–1042` fixes the rule — numbers are assigned at design
acceptance, ordered ascending in the file, each owner edits only its own block. `main` has assigned **1.8** to TUI
round 5 (commit `aa7dc3c`), which this worktree's copy of `DECISIONS.md` predates; `CD §E` item 5 confirms it.
Round 5's header line is therefore:

`// contract 1.8 (2026-09-22): TUI round 5 — coordination surface types, the context cell, the session label, the agents tab, the import overlay and the seven-provider widening, per docs/TUI-DESIGN-5.md §8; every item is optional or a default-preserving widening; CheckpointEnvelope.version stays 1.`

### 8.1 Items round 5 adds to `src/core/types.ts` (TUI-owned blocks)

```ts
// 1  BlockingKind (types.ts:1225) — the lease-conflict AND land-preflight panes (D-AF, §2.11).
//    *** NOT ADDITIVE (review #34). *** Four TUI-owned consumers are exhaustive with no default and break the
//    moment a member joins: pausedWord (src/tui/status/lines.ts:284), blockingRowsStructured
//    (src/tui/blocking/lines.ts:121), blockingStatusWord (:238), and the total Record<BlockingKind, …> at
//    test/unit/tui/pane/blocking.test.ts:58. Per CD §F the peer's W2b agent lands BOTH words WITH placeholder case
//    lines in those four spots in ONE commit; round 5 restyles the labels and owns both rows' strings/twins/keys.
//    BlockingAnswer (:1226) ALREADY carries 'wait' and 'worktree' under contract 1.4 with a comment naming the
//    lease-conflict pane, and PausePointReason (:1548) already has 'worktree', so no ANSWER member is needed.
//    *** THIS IS REQUEST R1: `types.ts:1225` and the four case lines are one harness commit. See §8.2. ***
export type BlockingKind = … | 'lease-conflict' | 'land-preflight';
// 2  UiLabel (types.ts:1461) — the label every APPLIED remote verb writes (§2.9). ADDITIVE IN src/, NOT IN test/.
//    CORRECTION (review #6, #44). An earlier draft asserted "Every consumer of UiLabel is a Record<UiLabel, …>?
//    NO — checked". TWO EXIST, both total, both fail tsc --strict (TS2741) the moment '[session]' joins:
//      test/unit/tui/theme.test.ts:343          const EXPECTED: Readonly<Record<UiLabel,'assistant'|'you'|'dim'>>
//      test/unit/tui/theme-palette.test.ts:848  the identical literal
//    Both take the two-line edit `'[session]': 'dim',` in the W0 contract PR's blast radius; §9.2 gives them an
//    owner row (round 4 assigned test/unit/tui/theme*.test.ts to its S5, so round 5 must claim them explicitly).
//    A THIRD file is stale but NOT broken: test/unit/core/contract.test.ts:64–67 hand-writes the six labels and
//    asserts toHaveLength(6) — a literal array, so it still compiles; the same PR updates it to seven for honesty.
//    src/tui/theme.ts:259 labelRole() falls through to 'dim', which IS the decided colour role for '[session]'
//    (a session-provenance label is chrome, not speech) — stated here so it is a decision, not an accident.
//    ChatLabel (:1462) is Extract<UiLabel,'[you]'|'[jevcode]'> and is unaffected.
//    `LABEL_GUTTER` is 10 cells and '[session]' is 9.
export type UiLabel = '[ui]' | '[setup]' | '[config]' | '[sandbox]' | '[you]' | '[jevcode]' | '[session]';
// 3  SessionRow (types.ts:1923) — the picker's cross-device rows (§2.8). ALL OPTIONAL.
readonly ended?: RunEnded | null;             // RunEnded already exists at :1597
readonly parentSessionId?: string | null;     // `parentRunId` already exists broadly; only the SESSION id is new
readonly workspaces?: readonly string[];      // one session, several checkouts (relocate / handoff)
// 4  SessionHost (types.ts:1901) — `peers?()` already exists and is unchanged; round 5 adds the fuller read so
//    `/who` does not need a second host method. OPTIONAL, null until the ledger is opened.
who?(): readonly SessionActivityView[] | null;
/** the TUI-facing projection of coordination's SessionActivity — a VIEW, so `src/tui/**` never imports
 *  `src/coordination/types.js` directly (§2.1 rule 1).
 *  NOT "field-for-field a subset" (review #11, #42): it is a FLATTENED PROJECTION of SessionActivity PLUS its
 *  `heartbeat`. The derivation column below is the mapper's spec; the mapper lives in src/session/peers.ts (R5-1)
 *  with its own table test. Nothing here is computed from anything but those two objects. */
export interface SessionActivityView {
  // ---- straight from SessionActivity (src/coordination/types.ts:434–458) ----
  readonly runId: string; readonly sessionId: string; readonly label: string;
  readonly parentSessionId: string | null;                 // :437 — §2.8's child rows need it
  readonly deviceId8: string;                              // sha-free: SessionActivity.deviceId (:438) first 8 chars
  readonly sameDevice: boolean;                            // :440
  readonly kind: 'run' | 'bench';                          // :441
  /** ALL FIVE Liveness members (:403). 'stale-reused-pid' is exactly §7 row 3's reused-pid case and
   *  lockReplaceVerdict's own edge list — narrowing to four LOSES a real state. §12 S3a renders it. */
  readonly liveness: 'live' | 'stale' | 'stale-reused-pid' | 'gone' | 'unknown';
  /** :445 — §2.1 rule 4 names this and `sameDevice` as WHAT THE RENDERER READS; §2.9's `(unverified)` rendering
   *  depends on it, so dropping it (as an earlier draft did) would have silently deleted that state. */
  readonly authority: 'self' | 'trusted' | 'unverified';
  readonly flags: { readonly hung: boolean; readonly skewed: boolean; readonly forked: boolean; readonly takenOver: boolean;
                    readonly noLock: boolean; readonly ignoredDevice: boolean; readonly unverified: boolean; readonly cloned: boolean };  // :443
  readonly beatAgeMs: number;                              // :449
  readonly arrivalAgeMs: number | null;                    // :451 — the liveness INPUT; beatAgeMs is display only
  readonly skewMs: number | null;                          // :447, display only, NEVER a liveness input
  readonly syncLagMs: number | null;                       // :453
  readonly sameRepo: boolean; readonly sameBranch: boolean | null;   // :454, :455
  readonly leaseCount: number;                             // :457 leases.length — the count only, never the paths
  // ---- projected from SessionActivity.heartbeat (:456; Heartbeat at :92–180) ----
  readonly step: number | null; readonly maxSteps: number | null;    // heartbeat.step / .maxSteps
  readonly stage: string | null;                           // heartbeat.stage (CoordStageName | 'idle')
  readonly mode: EngineMode | null;                        // heartbeat.mode
  readonly branch: string | null; readonly head: string | null;      // heartbeat.repo.branch / .head — S1's `main@3f9a2c1`
  readonly ctxPct: number | null;                          // heartbeat.context.pct
  readonly spend: { readonly totalUsd: number; readonly capUsd: number } | null;
  readonly editing: readonly string[];                     // heartbeat.touched?.files ?? []
  /** heartbeat.subwork (:145) — the ONLY source for S1's `lanes 2 · samples 3`. An earlier draft omitted it and
   *  pinned a string with no field to live in (review #42). `bench` is null on a run row, so it cannot serve. */
  readonly subwork: { readonly lanes: number; readonly samples: number; readonly probes: number; readonly children: number } | null;
  readonly bench: { readonly benchId: string; readonly done: number; readonly tasks: number; readonly lanes: number } | null;
}
/** the self half of the same discipline — SelfIdentity (src/coordination/types.ts:369) carries `hostKey`, a device
 *  secret derivative, and must never reach a JSON sink (§7 row 61). §13.3's `sessions who --json` emits THIS. */
export interface SelfIdentityView {
  readonly deviceId8: string; readonly label: string; readonly sameDeviceCount: number;
}
// 5  ConfirmRequest (types.ts:693) — the manifest confirm's four fields (§4.6, OR §3.7 [G2][D4][D5]). ALL OPTIONAL,
//    so every existing constructor and fake compiles unchanged; the five render branches substitute rows, never add.
//    *** THIS IS REQUEST R5: these are contract-1.5 shapes the peer owns. See §8.2. ***
readonly title?: string; readonly headline?: readonly string[]; readonly body?: readonly string[]; readonly badge?: string;
// 6  ProviderName (types.ts:649) and GeneratorConfig.provider (types.ts:2005) — the seven-provider widening (D-AP).
//    A WIDENING OF A REQUIRED FIELD, which is the one item in this block that is not purely optional; every existing
//    value stays valid, `src/provider/registry.ts:16-19`'s own CONTRACT NOTE says nothing else changes, and
//    `src/config/validate.ts:161`'s two-name check becomes `isProviderId(provider)`.
//    OWNERSHIP: `src/provider/registry.ts:16` states "(src/core/types.ts is owned by the TUI/session round)", so this
//    is round 5's OWN item, not a request. §8.2 R9 is a confirmation row; §15 Q9 asks the peer to say so once.
export type ProviderName = ProviderId | 'mock';       // ProviderId from src/provider/ids.ts:18
export interface GeneratorConfig { provider: ProviderId; … }
// 7  SettingName (src/config/types.ts:6) — TUI-owned, no request needed:
//    context.mode · context.compaction · context.kept · context.compactEvery · context.budgetChars   (§3.6)
//    import.enabled · import.scope · import.sources · memory.enabled · memory.path · seen.import     (§5)
//    coordination.claims · coordination.remoteControl · coordination.sync · coordination.syncRuns ·
//    coordination.notify · coordination.maxChildren                                                  (§2)
//    orchestrate.* (34 rows, OR §6.4)                                                                (§4.8)
// 8  ResolvedConfig.context?() (types.ts:2076) — DECLARED but never implemented; round 5 implements it in
//    src/config/resolve.ts and the doc comment's claim becomes true (D-AI). No type change.
// 9  IndexLine (src/session/index.ts:24) + INDEX_KINDS (:36) — TUI-owned, one commit, seven new kinds (D-AS):
//    'session:end' | 'relocate' | 'handoff' | 'agent:start' | 'agent:end' | 'land' | 'import'
//    plus `by?:` on the existing `pause` arm (:30) and `parentSessionId?:` on `run:start` (:25).
//    BOTH ARE OPTIONAL (review #17). The arms are all-required object literals and every `pause` line already on
//    disk lacks the field; a required `by` would fail the arm's shape for every historical session. Reader
//    defaults, stated: `by ?? 'self'`, `parentSessionId ?? null`. §10 folds a pre-round-5 `pause` line.
//    THE SAME COMMIT EXPORTS THE ARRAY (review #18, #55): today `const INDEX_KINDS: readonly string[]` (:36) is
//    module-private AND typed `string[]`, so nothing type-checks a bad kind and §10's membership test / gate
//    G-R5-10 cannot import it. It becomes `export const INDEX_KINDS: readonly IndexKind[]` — it can be, now that
//    `IndexKind = IndexLine['kind']` exists at :35 — so a kind absent from the union is a compile error.
// 10 not core, by owner (TUI-owned modules). EVERY line below names a file that has an owner row in §9.1 or a
//    verbatim-change row in §9.2 — the review found six files here with neither (#2, #33).
//    PaneTab gains 'a'. PANE_TABS STAYS FOUR MEMBERS and PANE_TABS_WITH_AGENTS is the five-member list;
//      cycleTab(tab, dir, tabs = PANE_TABS) — the default binds to the FOUR-tab constant, which is what keeps
//      test/unit/tui/pane/model.test.ts:165–167 green AND unedited (review #1, #31). paneTabsFor(hasDelegation).
//      TAB_TITLE (model.ts:322) gains a: 'agents'. PANEL_ARGS (registry.ts:97) gains 'a'. The TWO literal tab
//      strips at model.ts:355 and :377 become computed from paneTabsFor(...) (src/tui/pane/model.ts, §4.3).
//    KeyContext gains 'agents' (src/tui/keys/bindings.ts:12; KEY_CONTEXTS :15, §4.3) — AND resolveKey gains one
//      rung between Picker and Composer, gated on ui.paneFocus (src/tui/keys/resolve.ts:5, §4.3).
//    PickerOp (src/tui/keys/resolve.ts:169, a CLOSED union) gains 'cardOpen' | 'cardClose' | 'cardReplay' |
//      'cardFresh' | 'cardDiff' | 'cardWho' (§2.8's card sub-state).
//    UiState gains paneFocus: boolean + a { type:'paneFocus' } action (src/tui/useEngine.tsx:185, :283, §4.3).
//    PickerKind / PickerOpen gain the 'models' arm; pickerConsoleTitle(kind) widens from 'sessions'|'rewind'
//      (src/tui/App.tsx:255, :279, :626; src/tui/Picker.tsx; src/tui/Console.tsx:51, §6.4). NOT an OverlayKind.
//    GlyphSet gains NINE members with their ASCII twins (src/tui/glyphs.ts:11, UNICODE :105–156, ASCII, SR):
//      ● live → '*' · ○ gone → 'o' · ◌ stale → '.' · ⇄ peers → '<>' · ✉ mail → 'mail' · ⏸ paused → '=' ·
//      ⟳ landing → '~' · ↻ kicked → '@' · ↪ adopted → '>>'.
//      The '◌' twin is '.' EVERYWHERE (review #43): asciiTwins() (:223–232) is a ONE-TO-ONE map keyed by the
//      unicode glyph and "the first entry for a glyph wins", so S3's earlier '◌'→'o' and S60's '◌'→'.' could not
//      both hold. '○' takes 'o'; S3 is corrected, S60 stands.
//    labelRole (src/tui/theme.ts:259) is unchanged and '[session]' takes its 'dim' fall-through — a DECISION
//      (§8.1 item 2), recorded so it is not an accident.
//    Target / TargetResult / Resolved / Ambiguous / NotFound / Candidate / resolveTarget
//      (src/tui/commands/target.ts, NEW, zero I/O, §2.5).
//    peerViewOf(fold, self): PeerView, activityView(a): SessionActivityView, selfView(s): SelfIdentityView
//      (src/session/peers.ts, NEW, §2.4, §2.3).
//    SegmentId (src/tui/status/lines.ts:401) gains 'ctx', 'peers' AND 'agents' (review #45 — the strip needs one).
//      DROP_ORDER (:413) becomes ['help','spark','git','ctx','peers','sess','wall'] — 'agents' is NOT in it, like
//      'run'. StatusZones['dropped'] (:497), a SEPARATELY SPELLED union that dropped.push(d) (:543) writes into,
//      gains 'ctx' and 'peers' or the push does not compile. Push order in rightZoneSegments (:450) is
//      step · run · agents · sess · tokens · ctx · peers · git · spark · help · secret (§2.2).
//      CONTEXT_MIN_COLUMNS = 80, CONTEXT_FULL_COLUMNS = 100, PEERS_MIN_COLUMNS = 80, HEADSUP_MIN_COLUMNS = 100,
//      AGENTS_MIN_COLUMNS = 40 (§2.2, §3.1, §4.4).
//    OverlayKind gains 'import' ONLY; COLLAPSING gains 'import'; OverlayData gains import?
//      (src/tui/layout.ts:52, :55, :58; src/tui/Overlay.tsx, §5.2). 'models' is NOT an overlay (review #13).
//    WizardStep gains 'import' (src/tui/onboarding/reducer.ts:26, §5.1).
//    CommandAction gains 'who' | 'inbox' | 'tell' | 'headsup' | 'request' | 'end' | 'context' | 'compact' |
//      'split' | 'agents' | 'agent' | 'land' | 'spawn' | 'import' | 'memory'; { kind:'pause' } gains a payload;
//      { kind:'provider' } widens to ProviderId | null (src/tui/commands/dispatch.ts:45, :59, §2.6, §6.5).
//    FactKey gains 'peers' and 'memory' (src/chat/facts.ts:17, 14 members today, §2.3, §5.5).
//    Command gains 'import', 'models' AND 'agents' (src/cli/args.ts:19 union + :20 COMMANDS + usage text +
//      a case arm in src/cli/main.tsx's switch (command) at :425–484) — the third member was missing and made
//      `jevcode agents list` unreachable while G-R5-10 still passed (review #7, §4.2).
//    agentRowText / agentRows / agentStripText / agentCard (src/tui/agents/lines.ts, NEW, §4.2).
//    ImportUiState / importLines / IMPORT_* anchors (src/tui/import/**, src/config/imports.ts, NEW, §5.2–§5.3).
//    ModelPickerState / modelPickerLines (src/tui/models/**, NEW, §6.4).
//    RENUMBERING, one commit with the above (review #56): eight doc comments in the TUI-owned blocks of
//      src/core/types.ts still read `contract 1.6 item N (TUI-DESIGN-4 …)` from round 4's draft numbering
//      (:1048, :1785, :1820, :1827, :1849, :1900, :1903, :1983), while the header at :14 says `contract 1.7
//      (2026-09-22): TUI round 4` and §8 reserves 1.6 for import. Round 5 owns those blocks and renumbers all
//      eight to `contract 1.7 item N`; contract.test.ts gains an assertion that no `contract 1.6 item` comment
//      cites a TUI-DESIGN-4 section, so the collision cannot recur when import lands its real 1.6 items.
```

### 8.2 REQUESTS to the harness (peer) session — every one named, with the wave that brings it

Each row is written so the peer can land it without a second design pass. **Re-scoped against `CD §F` (§14.2 #32):
R2, R5 and R11 are recorded on `main` at `2400a0c` and are now _confirmations_, not asks** — this worktree simply
predates them, and round 5's first act is the rebase-and-re-verify sweep of gate G-R5-11. **R1 and R13 are the only
two that block a round-5 surface**; R14 blocks two §6.3 rows but has a stated TUI-side fallback; everything else is
already available or has a fixture-first fallback (§8.4).

| # | Request | File:line today | Exact change | Blocks | Peer wave |
| ---: | --- | --- | --- | --- | --- |
| **R1** | `BlockingKind` gains `'lease-conflict'` **and `'land-preflight'`**, **with** the four placeholder case lines | `src/core/types.ts:1225` (6 members) | **NOT one additive word — one commit of five edits** (§14.2 #34). The union line, plus a case in `pausedWord` (`src/tui/status/lines.ts:284`), `blockingRowsStructured` (`src/tui/blocking/lines.ts:121`), `blockingStatusWord` (`:238`) and the total `Record<BlockingKind, …>` at `test/unit/tui/pane/blocking.test.ts:58` — all four are exhaustive with no `default`, so `tsc --strict` breaks regardless of whether anything routes to the new kinds. `CD §F` records the peer's agreement to land it exactly this way; round 5 restyles the labels | §2.11's two panes only (§7 row 34) | **wave 0** — `CD §F` puts it in the peer's W2b; if it slips both panes defer to round 6 and nothing else in §2 changes |
| **R2** | *(confirmation — **landed on `main` at `2400a0c`**, `CD §F`)* `meter.hold(agentId, usd)` / `release(agentId)` / `heldUsd()` / `snapshot().heldUsd`, restored by `restore()` under `RESTORED_HOLD_ID` | absent **in this worktree** (`src/spend/meter.ts` has no `hold`/`release`; `SpendSnapshot` `:722–732` has no `heldUsd`) — present on `main` | nothing for the peer to do. **Round 5's own half is four call sites, not two** (§14.2 #36): `src/cli/session.ts:2021`, `:2347` **and** `childCapUsd` (`src/tui/budget/lines.ts:194–195`), `followUpDecision` (`:202–203`) — the last two gate money and `main` already fixed them at `d8490fa`. Confirm after the rebase. Adoption must `release(RESTORED_HOLD_ID)` after re-holding per agent (`CD §F`) | `/cost`'s `held`/`free` cells (§4.10) | **already on `main`**; until the rebase `/cost` omits both cells |
| **R3** | `EngineStatus.orchestration?` | `grep -n "orchestration" src/core/types.ts` → **zero** | OR §4.1's shape | the collapsed agents strip's live numbers (§4.4) | contract 1.5 |
| **R4** | `formatMeter`/`formatBudget`/`formatRecentSteps` take an optional `g: GlyphSet` (default unicode) | `src/loop/context/meter.ts:89`, `:95`, `:109` — the `·` is a literal at `:112` | one optional parameter, mirroring `modeBadgeWord`'s signature; additive, test-covered | nothing — the TUI's `replaceAll(' · ', g.dot)` stopgap works (§3.1, §7 row 40) | any wave |
| **R5** | *(confirmation — **landed on `main` at `2400a0c`**, `CD §F`)* `ConfirmRequest.title/headline/body/badge` | `src/core/types.ts:693–702` **in this worktree** — present on `main`, with `headline` ≤ 5 rows and the `dirtyOverlap` warning as row 0; `proposal`/`risk` are [D5c]'s fixed literals and **there is no `matchesIntent`** | nothing for the peer to do; confirm the hash. Round 5 owns the five count-preserving render branches and the `review:why` refusal while `headline` is set (§4.6) | §4.6's manifest confirm, §7 row 51 | **already on `main`** |
| **R6** | `acquireRunLock`/`takeRunLock`'s replace decision consults `lockReplaceVerdict` | `src/session/lock.ts:57`'s older `lockIsLive(lock, {host, isAlive})` consults neither `peerLive` nor `bootId`; `lockReplaceVerdict` at `src/coordination/records.ts:829` has **no caller** | wire the decision; round 5 wires the six-reason **explanation** (§2.10) regardless, so the two cannot drift | nothing (the CLI text lands either way) | the engine wave |
| **R7** | `renderReport`/`renderPlanJson` accept and thread the caller's exact redactor | `src/import/report.ts:273`, `:295` call `redactSecrets(text)` with no second argument; `discover.ts` and `index.ts:331` do thread it | add an `exact?: { redact }` parameter and pass it from every call site | nothing today; it is a redaction asymmetry in what a human reads before pressing `y` (§7 row 63) | import W4 |
| **R8** | `FORMAT_PATTERNS` gains xAI, Fireworks and Meta key families | `src/core/redact.ts:68–75` has OpenRouter, Anthropic, OpenAI and Google only | three prefix regexes, verified live against a real key shape before landing | nothing; a pasted-but-unsaved key of those shapes is uncaught by the pattern layer (§7 row 64) | any wave |
| **R9** | *(confirmation only, not a hunk)* round 5 widens `ProviderName` (`:649`) and `GeneratorConfig.provider` (`:2005`) to `ProviderId` **itself**, as contract 1.8 item 6 | as cited | `src/provider/registry.ts:16` already assigns `src/core/types.ts` to "the TUI/session round" and says this is the only change needed. The peer is asked to confirm no in-flight harness change touches those two lines in the same window | §6.1 if it does not land; the picker would be browse-only and need a refusal string that is then deleted | wave 0 |
| **R10** | `StageName` gains `'coordinate'`; `StepRecord.coord` carries the advisory conflict facts | `src/core/types.ts:243` has 8 members, no `'coordinate'`; no `coord` field exists | CO §4.2's shape | **nothing in round 5** — the advisory heads-up UI is explicitly deferred; round 5 reads the fold, not a step record | W2b per `CD §E` item 4 |
| **R11** | *(confirmation — **landed on `main` at `2400a0c`**, `CD §F`)* `StageName 'decompose'`; `PausePointReason 'delegate'` (P9) and `'review-needed'` (P10); the `agent:*` / `decompose:*` / `orchestration:proposed` / `agent:adopted` events; `EngineOptions.{splitPolicy, orchestration, blocker, confirmer}`; `Engine.land(input, ask?)` | `:243` (8 members), `:1543` (5 members) **in this worktree** — present on `main` | nothing for the peer to do. **The still-open dependency is harness D1's `src/loop/stages/decompose.ts` + its engine wiring** (`CD §B` item 5), which is what N1 now cites | `AgentSupervisor`, which round 5 does not build (N1) | **contract already on `main`**; D1 pending |
| **R12** | a public alias `Ledger = LedgerHandle` for external consumers | `src/coordination/types.ts:466` (7 members) vs `src/coordination/ledger.ts:189` | the peer already plans it (`CD §E` item 3) | nothing — round 5 types against `LedgerHandle` today (D-AD) | W2b |
| **R13** | `contextEnabled` includes `'llm-jev'` — **the one new blocking request** | `src/loop/engine.ts:922`: `this.contextEnabled = this.contextPolicy.view === 'relaxed' && (this.mode === 'jev-on' \|\| this.mode === 'jev-off');` | either add `\|\| this.mode === 'llm-jev'`, or populate `EngineStatus.context` from the `llm-jev` `SynthesisContext.contextText` path. The contract's own comments already read this way: `types.ts:1345–1347` builds `contextText` "for a synthesizer that prompts the generator itself (llm-jev)" and names only `jev-only`/`view: 'legacy'` as absent, and `Engine.compact?`'s comment at `:1776` names the same two | **requirement 3 in the product's default mode.** `DEFAULT_MODE = 'llm-jev'` (`src/config/defaults.ts:50`), so without this the `ctx` cell and `/context` are empty out of the box (§1.1, §3.1, §7 row 35) | **before R5-3's W2.** If it slips, §1.1's reduced scope stands and every empty state names `/mode jev-on` |
| **R14** | `PROVIDER_BASE_URL` and `PROVIDER_DISPLAY_NAME` move **into `src/provider/ids.ts`** | `BASE_URLS` at `src/config/defaults.ts:67` (two entries); display names at `src/tui/onboarding/lines.ts:41` and `providerDisplayName` at `src/models/providers.ts:183` | two `Readonly<Record<ProviderId, string>>` tables beside `PROVIDER_KEY_ENV` (`ids.ts:36`), re-exported by `models/providers.ts` exactly as `keyEnvNames` already is (`ids.ts:53`, `providers.ts:33`). **Reading them from `models/providers.ts` instead would put `provider/openrouter.js` (imported at `providers.ts:23`) on the argv path** through `config/defaults.ts` ← `cli/args.ts`, breaking `providers.ts:28–31`'s own stated rule and failing G-R5-1 (§6.3, §14.2 #5) | §6.3 rows 2 and 5 | **any wave. Fallback:** a zero-import TUI-owned `src/config/provider-tables.ts` with an import-gate test, deleted when R14 lands |
| **R15** | delete the engine's `decomposeBody()` once `src/tui/agents/lines.ts` renders the same rows | harness-owned, named by `CD §F` to-do 3 | one deletion plus the event payload the TUI already consumes | nothing — two renderings coexist harmlessly until then, but they will drift | after round 5's `agents/lines.ts` lands |

### 8.3 Config rows added this round

`context.*` (5, enumerated §3.6) · `coordination.*` (6, enumerated §8.1 item 7) · `import.*`/`memory.*`/
`seen.import` (6, enumerated §8.1 item 7) · `orchestrate.*` (**34, now enumerated in §4.8** — §14.2 #19: citing a
count made G-R5-8 vacuous for thirty-two of them). **No default changes** to any existing row. Every one is printed
by `jevcode config`, validated by `jevcode config set`, and asserted by `contract.test.ts`. The assertion's wording
is fixed too: **"every key in `docs/ORCHESTRATION-DESIGN.md` §6.4's table (`:1427–1461`) and every
`context.*`/`coordination.*`/`import.*`/`memory.*` name in §3.6 and §8.1 item 7 has a `SETTINGS` row, and no two
round-5 slots claimed the same key"** — an external authority, not "every name this document mentions".

### 8.4 The fixture-first fallback, per unlanded dependency

The rule, stated once: **a slot never waits; it builds against a typed fixture and a stub with the real
signature, and swaps the import when the dependency lands.** Per dependency:

**The premise, stated first (§14.2 #50).** *The brief says round 4 lands **before** round 5 is implemented, and it
is being implemented right now in a sibling worktree.* So **W0's stub step is deleted and every slot imports the
real modules.** The table below is a **contingency only**, and it carries the correction the review forced: the
stubs must **not** sit at round 4's own paths. TD4 §8 item 11 assigns `src/tui/block/lines.ts`, `src/tui/fit.ts`
and `src/tui/gutter.ts` (the last "NEW and zero-import") to round-4 slots; a stub at those paths is a head-on
collision with in-flight work, not a fallback. (TD4 also never defines a `src/tui/block/render.ts` — the draft
invented it.) A contingency stub therefore lives at `src/tui/block/__stub__.ts` etc., and the swap is then **a
one-line import change per file**, not the "no call site changes" the draft promised. That is the honest cost.

| Unlanded thing | The stub round 5 builds against *(contingency only)* | The swap |
| --- | --- | --- |
| round 4's `src/tui/block/lines.ts` (`BlockRow`, `blockWidth`, `renderBlock`, `detailRole`, `LABEL_GUTTER`) | `src/tui/block/__stub__.ts` with TD4 §8 item 11's **exact** signatures and a naive `note`-per-row body | re-point the import in each file; delete the stub |
| round 4's `src/tui/fit.ts` (`fitRung`) | `src/tui/__stub_fit__.ts` returning the first rung whose `cellWidth` fits | same |
| round 4's `src/tui/gutter.ts` (`gutterMode`, `LABEL_GUTTER`) | `src/tui/__stub_gutter__.ts`, zero-import, `LABEL_GUTTER = 10` | same |
| contract 1.5's `AgentRow`/`Manifest`/… | **not a stub** — the real types, `import type` only, from `src/orchestrate/index.js` (`:21–46`) (D-AK, §4.1). That module is a **value** module reaching `node:fs/promises`, so a value import would break G-R5-1 | re-point to `src/core/types.js`; 1.5 is already on `main` at `2400a0c`, so this likely happens inside round 5 |
| `EngineStatus.orchestration?` (R3) | a local `OrchestrationStatus` type in `src/tui/agents/lines.ts` used **only** as the row builders' parameter type, never persisted, never on a contract surface | replace the parameter type; the builders are unchanged |
| `ConfirmRequest.title/…` (R5) | the manifest card is built but **not reachable** — no code path constructs one — and is exercised only by `review.test.tsx`'s fixtures | remove the fixture gate |
| `meter.heldUsd()` (R2) | `/cost` omits the `held` and `free` cells entirely (not zero — omitted, the same rule as the resume card's `ctx`) | pass the third argument at the two call sites |
| `BlockingKind 'lease-conflict'` / `'land-preflight'` (R1) | the two panes' `lines.ts` builders exist and are unit-tested behind an `it.skip` naming R1. **"Nothing routes to it" is not the reason it is safe** (§14.2 #34) — the four exhaustive consumers break on the union edit whether or not anything routes, which is why R1 is one commit of five edits and not a TUI-side fallback at all | the peer's commit lands the word and the four cases; round 5 replaces the placeholders with the real rows |

---

## 9. Module map — six slots, exclusive files, waves

**The rule, unchanged from rounds 3 and 4:** every file has exactly one owner; a slot that needs a change in
another slot's file sends a **request**, and §9.2's rows are those requests written verbatim so the owner lands
them without a second design pass. A slot that needs an App-level test writes it in its **own**
`round5-<slot>-app.test.tsx` over the shared harness (`test/unit/tui/app-harness.tsx`, read-only this round) —
never in `app.test.tsx` / `round2-*` / `round3-*` / `round4-*`.

**§9.1 is the single source of truth for "may I edit this file".** Every §9.2 row cites a file that appears in
some slot's §9.1 "Owns" cell; where the two disagreed the review made §9.1 win (§14.2 #20, #54). Three
disagreements are fixed: `src/tui/commands/registry.ts` joins R5-2's cell, `src/cli/session.ts` joins R5-1's, and
`src/config/resolve.ts` gets its own §9.2 row under R5-3. **Ten files the review found with no owner and no
request row are added** (§14.2 #2, #33, #49): `App.tsx`, `Pane.tsx`, `useEngine.tsx`, `Picker.tsx`, `Console.tsx`,
`StatusLine.tsx`, `src/cli/main.tsx`, `src/tui/keys/resolve.ts`, `src/tui/glyphs.ts` and the two `theme*.test.ts`
files — without them the `'a'` tab cannot be mounted, the model picker has no reducer, the import overlay has no
dispatch, nine glyphs do not exist and W0 does not compile.

This map starts from `CD §C`'s six-slot proposal and refines it in four ways: (1) the context slot absorbs the
whole `context.*` config chain, not just a schema row (D-AI); (2) the provider/model picker — absent from `CD §C`
entirely — becomes its own slot, R5-6, and the session-index convergence moves to R5-1 which already owns
`src/session/**`; (3) the agents-tab work joins R5-4 rather than being split across two slots, because
`src/tui/pane/model.ts` and `src/tui/agents/lines.ts` are one change; (4) every shared file gets an explicit owner
row in §9.2 with the wave that lands it.

### 9.1 Slots and the files each may edit

| Slot | Owns (edit unless marked **new**) | Sections |
| --- | --- | --- |
| **R5-1 coordination: session state, the picker, the index, the write half** | `src/session/index.ts` (**the one `INDEX_KINDS` commit, on behalf of all six slots** — D-AS), `src/session/picker-lines.ts`, `src/session/seed.ts`, `src/session/peers.ts` (**new** — `peerViewOf`, `activityView`, `selfView`), `src/session/lock.ts`, `src/cli/sessions.ts` (4 → 17 verbs), **`src/cli/session.ts`** (added §14.2 #20/#54 — it was owner in §9.2 and absent from §9.1; R5-1 also lands §2.14's heartbeat/claim/lease writes here), `src/chat/facts.ts` (the `peers` fact), `test/unit/session/**`, `test/unit/cli/sessions.test.ts`, `test/unit/tui/round5-coord-app.test.tsx` (new) | §2.3, §2.4, §2.8, §2.10, **§2.14**, §8.1 items 3, 4, 9 |
| **R5-2 coordination: commands, targets, messaging, the status zone, the contract block** | `src/tui/commands/target.ts` (**new**), **`src/tui/commands/registry.ts`** (added §14.2 #20 — it was owner in §9.2 and absent here), `src/tui/commands/dispatch.ts`, `src/tui/commands/parse.ts`, `src/tui/toasts.ts`, `src/tui/blocking/lines.ts` (the lease-conflict **and land-preflight** cards), `src/tui/status/lines.ts` (**the `peers`, `ctx` and `agents` segments, `DROP_ORDER`, `StatusZones['dropped']` — shared, §9.2**), `src/core/types.ts` (round 5's contract block only), `src/tui/glyphs.ts` (**the nine new `GlyphSet` members**, §8.1 item 10), `src/tui/theme.ts` (the `'[session]'` decision — no code change, a comment), `test/unit/tui/commands/**`, `test/unit/tui/{status,blocking,toasts,glyphs}*.test.ts*`, **`test/unit/tui/theme.test.ts`, `test/unit/tui/theme-palette.test.ts`** (the two total `Record<UiLabel, …>` literals, §8.1 item 2), `test/unit/tui/pane/blocking.test.ts` (the total `Record<BlockingKind, …>`), `test/unit/core/contract.test.ts` | §2.2, §2.5, §2.6, §2.7, §2.9, §2.11, §8 |
| **R5-3 context meter, compaction, the config chain** | `src/tui/context/lines.ts` (**new** — the `/context` block builder and `ctxText`), `src/config/resolve.ts` (`resolveContextConfig` + `ResolvedConfig.context()`; **also the owner of §6.3 row 1's `PROVIDER_KEY_ENV` hunk — own §9.2 row**), `src/config/{types,defaults,validate}.ts` (**the `context.*` rows — shared, §9.2**), `test/unit/tui/context/**`, `test/unit/config/context.test.ts` (new) | §3 |
| **R5-4 the agent tree, the key resolver, the shared React shell** | `src/tui/agents/lines.ts` (**new**), `src/tui/pane/agents.ts` (**new**), `src/tui/pane/model.ts` (`PaneTab 'a'`, `PANE_TABS_WITH_AGENTS`, `paneTabsFor`, `cycleTab`'s third parameter, `TAB_TITLE`, **the two literal tab strips at `:355`/`:377`**), `src/tui/pane/commands.ts`, `src/tui/keys/bindings.ts` (`KeyContext 'agents'` + the computed titles), **`src/tui/keys/resolve.ts`** (the `agents` rung, the six new `PickerOp` members), **`src/tui/App.tsx`, `src/tui/Pane.tsx`, `src/tui/useEngine.tsx`, `src/tui/Picker.tsx`, `src/tui/Console.tsx`, `src/tui/StatusLine.tsx`** (the shared React shell — **one owner, one W3 PR, every slot's hunk verbatim in §9.2**, §14.2 #2/#33), `src/tui/Review.tsx`, `src/tui/review/lines.ts` (the five count-preserving branches + the `review:why` refusal), `src/undo/{diff,plan,pager}.ts` (`landedUndoOffer`/`rewindRefusal`, `CD §F` to-do 5), `src/cli/agents.ts` (**new**), `src/tui/plain.ts`, `test/unit/tui/agents/**`, `test/unit/tui/pane/**`, `test/unit/tui/{keys,review,picker}*.test.ts*`, `test/unit/undo/**`, `test/unit/tui/round5-agents-app.test.tsx` (new) | §4, §2.8's card sub-state |
| **R5-5 the import surface** | `src/cli/import.ts` (**new**), `src/config/imports.ts` (**new**), `src/tui/import/{reducer,lines,Report.tsx}` (**new**), `src/tui/onboarding/{reducer,lines,Wizard.tsx}` (the `'import'` step — **`lines.ts` is R5-5's alone; R5-6's §6.3 row-5 hunk arrives as a §9.2 request**, §14.2 #49), `src/tui/layout.ts` (`OverlayKind`/`OVERLAY_KINDS`/`COLLAPSING`/`OverlayData` — **`'import'` only; `'models'` is not an overlay**, §6.4), `src/tui/Overlay.tsx`, `test/unit/tui/import/**`, `test/unit/cli/import.test.ts`, `test/unit/tui/onboarding/**`, `test/unit/tui/round5-import-app.test.tsx` (new) | §5 |
| **R5-6 provider, model picker, key setup** | `src/tui/models/{state,lines}` (**new** — the picker's rows and reducer; **the React component is `src/tui/Picker.tsx`'s new `'models'` arm, owned by R5-4**, §6.4), `src/cli/models.ts` (**new**), `src/config/credentials.ts`, `src/config/provider-tables.ts` (**new, zero-import — the R14 fallback only**, §6.3), `src/cli/login.ts`, `src/cli/main.tsx` (**the `switch (command)` arms for `import`, `models` and `agents` — shared, §9.2**), `src/cli/args.ts` (**the three `Command` members and every new flag — shared, §9.2**), `test/unit/tui/models/**`, `test/unit/cli/{models,login,args}.test.ts`, `test/unit/config/provider.test.ts`, `test/unit/tui/round5-models-app.test.tsx` (new) | §6 |

`src/synth/**`, `src/bench/**`, `src/jev/**`, `src/loop/**`, `src/coordination/**`, `src/orchestrate/**`,
`src/import/**`, `src/models/**`, `src/provider/**`, `src/spend/**`, `src/checkpoint/**`, `src/errors.ts` and
`src/core/types.ts`'s non-TUI blocks are **read-only** this round. Everything round 5 needs in them is a numbered
REQUEST in §8.2.

### 9.2 Shared files: the owner, and every change another slot needs — written verbatim

| File | Owner | For | Change (verbatim) | Wave |
| --- | --- | --- | --- | --- |
| **`src/tui/commands/registry.ts`** | **R5-2** | all six | **Six requests, one file, ONE PR at the end of the wave** (TD4 §9.2's own pattern for this file). R5-2 adds rows `who`, `inbox`, `tell`, `headsup`, `request`, `end` and widens `pause`'s `args`/`flags` to `[now] [<target>]`. R5-3 adds rows `context` (`availableDuringTask: 'any'`, `category: 'inspect'`) and `compact` (`'live'`, `'run'`). R5-4 adds rows `split`, `agents`, `agent`, `land`, `spawn`, adds `'a'` to `PANEL_ARGS` (`:97`) and the `panel` row's `valueHints`, and adds `land` to `EXCLUSIVE_COMMANDS` (`src/cli/session.ts:218`) and `destructive: true`. R5-5 adds rows `import`/`imp` and `memory`/`mem` (`category: 'config'`). R5-6 replaces `/provider`'s `ArgSpec.values` at `:357` with `[...PROVIDER_IDS]` and leaves `/model`'s `args` as `kind: 'text'`. **Count: 37 → 41 (round 4) → 56.** `POPULAR` (`:86`, 16 entries) is unchanged | **W4**, one PR |
| **`src/session/index.ts`** | **R5-1** | all six | **One commit, seven kinds** (D-AS): `INDEX_KINDS` (`:36`) gains `'session:end'`, `'relocate'`, `'handoff'` (R5-2), `'agent:start'`, `'agent:end'`, `'land'` (R5-4), `'import'` (R5-5); `IndexLine` (`:24–34`) gains one arm per kind; the existing `pause` arm (`:30`) gains `by: 'self' \| \`peer:${string}\` \| \`device:${string}\``; the `run:start` arm (`:25`) gains `parentSessionId: string \| null`. **Names are final** (`CD §E` item 7); no renames. Appending is safe — the array is read by membership, never by position | **W4**, one commit, last |
| **`src/cli/args.ts`** | **R5-6** | R5-4, R5-5 | R5-4 adds `--parent`, `--parent-session`, `--agent`, `--manifest`, `--own`, `--base`, `--split`, `--max-agents`, `--yes-split`, `--no-wait` to `STRING_FLAGS`/`BOOLEAN_FLAGS` and the usage text. R5-5 adds `Command += 'import'` (`:19–20`, both the union and the `COMMANDS` array) plus `--dry-run`, `--yes`, `--scope`, `--source`, `--resume`, `--undo`. R5-6 adds `Command += 'models'` and `--provider` widening. **Three requests, one file, one PR** | **W4** |
| **`src/config/{types,defaults,validate}.ts`** | **R5-3** | R5-2, R5-4, R5-5, R5-6 | R5-3 lands the 5 `context.*` rows **and** the resolver (§3.6). R5-2 lands the 6 `coordination.*` rows. R5-4 lands the **34 `orchestrate.*` rows enumerated in §4.8**. R5-5 lands `import.enabled`, `import.scope`, `import.sources`, `memory.enabled`, `memory.path`, `seen.import` (the last `hidden: true`, following `seen.defaultMode` at `defaults.ts:154`). R5-6 replaces `BASE_URLS` (`defaults.ts:67`) with an import of `PROVIDER_BASE_URL` from **`provider/ids.ts`** (§8.2 R14) or from the zero-import fallback — **never `providerSpec(id)`, which would put `provider/openrouter.js` on the argv path** (§6.3, §14.2 #5). **Five requests, one owner, one PR** | **W4** |
| **`src/config/resolve.ts`** *(its own row — the draft folded §6.3 row 1 into the `{types,defaults,validate}` row whose file set does not contain it, §14.2 #20)* | **R5-3** | R5-6 | R5-3's own: `resolveContextConfig(reader)` and `ResolvedConfig.context()` (§3.6). R5-6: delete the private two-entry `PROVIDER_KEY_ENV` at **`:89`** and its use at `:514`, importing `provider/ids.ts`'s 7-entry multi-name form — **a live bug fix**: `gemini`'s `GOOGLE_API_KEY` and `meta`'s `MODEL_API_KEY` fallbacks are unreachable today | **W4**, in the same PR as the config rows (constraint (c)) |
| **`src/tui/status/lines.ts`** | **R5-2** | R5-3, R5-4 | R5-2 adds `'peers'` to `SegmentId` (`:401`), `peerZoneText(fold, self, g, columns)` with `PEERS_MIN_COLUMNS = 80` / `HEADSUP_MIN_COLUMNS = 100`, **and the one `pausedWord` (`:284`) placeholder case** if R1's hunk has not arrived. R5-3 adds `'ctx'`, `ctxText` + `CONTEXT_MIN_COLUMNS = 80` / `CONTEXT_FULL_COLUMNS = 100`. R5-4 adds `'agents'` to `SegmentId` and `agentStripText` with `AGENTS_MIN_COLUMNS = 40`. **Three further edits the draft omitted** (§14.2 #45): `DROP_ORDER` (`:413`) becomes `['help','spark','git','ctx','peers','sess','wall']` (7 entries, `'agents'` **not** in it); `StatusZones['dropped']` (`:497`) gains `'ctx'` and `'peers'` or `dropped.push(d)` (`:543`) does not compile; and `rightZoneSegments` (`:450`) pushes in the order `step · run · agents · sess · tokens · ctx · peers · git · spark · help · secret`. **One edit, landed by R5-2, listing all three segments** | **W3** — all of it, R5-2's own rows included (§14.2 #54: the draft listed this file at two different waves) |
| **`src/cli/session.ts`** | **R5-1** (now also in R5-1's §9.1 cell) | R5-2, R5-3, R5-4, R5-6 | R5-1's own: §2.14's `await import('../coordination/index.js')`, `openLedger`, `createHeartbeatWriter`, the claim mint and the lease writes, all after `renderer.firstFrame()`. R5-2: `resumeRun`'s `claimRefusal` call (`:2296`) and the pause index line's optional `by` (`:1550`). R5-3: **`contextPolicy: rcfg.context?.()` at each `createEngine`/`defaultEngineFactory` site** — this is constraint (c)'s carve-out, see §9.3. R5-4: `land` into `EXCLUSIVE_COMMANDS` (`:218`, 11 members today), the `[G7]` parking blocker at `:2066` and `:2390` plus `SessionControllerOptions.orchestration` (`CD §F` to-do 1), and the 3-argument `sessionRemainingUsd` at `:2021`, `:2347`. R5-6: `keyEnvNames(providerOfConfig(config))[0]` replacing the inline ternary at **`:1818`** (§6.3 row 8 — the draft attributed this to R5-3; §6.3 and §9.1 both say R5-6, corrected here, §14.2 #8), and the `/model` handler at **`:3071`** gains the `findModel`/`nearMisses` **check** (a warning, not a refusal, §6.4). **One PR at the end of the wave** | **W4** |
| **`src/tui/layout.ts`, `src/tui/Overlay.tsx`** | **R5-5** | — | R5-5 adds `'import'` to `OverlayKind` (`layout.ts:52`, 10 members today), `OVERLAY_KINDS` (`:55`) and `COLLAPSING` (`:58`, 5 members), and `import?` to `OverlayData`. **R5-6 adds nothing here** (§14.2 #13): the model picker is a **pane-slot picker**, not an overlay — `OverlayKind` has no picker member at all and `/resume`, the precedent D-AQ cites, is `App.tsx:626`'s separate reducer rendered at `PICKER_PANE_WANT = 12` (`src/tui/Picker.tsx:163`). **One request, one PR** | W3 |
| **`src/tui/App.tsx`, `src/tui/Pane.tsx`, `src/tui/useEngine.tsx`, `src/tui/Picker.tsx`, `src/tui/Console.tsx`, `src/tui/StatusLine.tsx`** *(new — the shared React shell; none of these had an owner or a request row, and all five new surfaces have to be mounted, key-routed and state-held here, §14.2 #2, #33)* | **R5-4** | R5-2, R5-5, R5-6 | **ONE PR, one owner, every hunk verbatim.** **R5-2:** `useEngine.tsx` — the fold/peers slice on `UiState` and the `[session]` transcript routing; `StatusLine.tsx` — the three new segments are already data-driven off `statusZones`, so this is the prop pass-through only. **R5-4:** `Pane.tsx` mounts the `'a'` tab beside `d/p/t/s`; `App.tsx:1419` passes `paneTabsFor(state.agents.length > 0)` to `cycleTab`; `useEngine.tsx:185` gains `paneFocus: boolean` and `:283` the `{ type:'paneFocus' }` action; `App.tsx` routes `Alt+A`. **R5-5:** `App.tsx`'s overlay dispatch gains the `'import'` case. **R5-6:** `App.tsx:255` `PickerOpen` and `:279`'s `{ type:'picker' }` gain the `'models'` arm, `Picker.tsx`'s `pickerReducer` (`:64`) gains its rows, `Console.tsx:51` `pickerConsoleTitle(kind)` widens from `'sessions' \| 'rewind'`. **R5-1/R5-4:** `Picker.tsx` gains `PickerState.card` for §2.8's sub-state | **W3** |
| **`src/tui/keys/resolve.ts`** *(new row, §14.2 #33, #40, #41)* | **R5-4** | R5-1 | R5-4: one rung between Picker and Composer for `KeyContext 'agents'`, gated on `ui.paneFocus && ui.tab === 'a'` (the chain at `:5` has no pane rung today). R5-1: the six new `PickerOp` members at `:169` for the resume card's sub-state (`'cardOpen' \| 'cardClose' \| 'cardReplay' \| 'cardFresh' \| 'cardDiff' \| 'cardWho'`) and their `src/tui/keys/bindings.ts` picker-block rows | **W3** |
| **`src/tui/glyphs.ts`** *(new row, §14.2 #43)* | **R5-2** | R5-1, R5-4 | the **nine** new `GlyphSet` members (`src/tui/glyphs.ts:11`) with their `UNICODE` (`:105–156`), `ASCII` and `SR` twins: `●`→`*`, `○`→`o`, `◌`→`.`, `⇄`→`<>`, `✉`→`mail`, `⏸`→`=`, `⟳`→`~`, `↻`→`@`, `↪`→`>>`. `asciiTwins()` (`:223–232`) is **one-to-one and first-wins**, so no two members may share a unicode glyph and `◌`→`.` is the single answer (S3 corrected, S60 stands). `glyphSet` keeps its options-object signature (`:216`) | **W1** — every other slot's strings depend on it |
| **`src/cli/main.tsx`** *(new row, §14.2 #7, #33)* | **R5-6** | R5-4, R5-5 | the `switch (command)` at **`:425–484`** gains `case 'import':` (R5-5), `case 'models':` (R5-6) and `case 'agents':` (R5-4), each an `await import()` of its `src/cli/<verb>.ts`. **The static import list at `:15–35` gains nothing** — `main.tsx:31` already statically imports `./session.js`, which is why §2.1 rule 3a exists | **W4**, with `args.ts` |
| **`test/unit/tui/theme.test.ts`, `test/unit/tui/theme-palette.test.ts`** *(new row, §14.2 #6, #44)* | **R5-2** | — | the two-line edit `'[session]': 'dim',` in the total `Readonly<Record<UiLabel, 'assistant'\|'you'\|'dim'>>` literals at **`theme.test.ts:343`** and **`theme-palette.test.ts:848`**. Without it `tsc --strict` fails **in W0** with TS2741. Round 4 assigned `test/unit/tui/theme*.test.ts` to its S5, so round 5 claims them explicitly. `test/unit/core/contract.test.ts:64–67` still compiles (a hand-written array) but is updated from 6 to 7 in the same PR | **W0**, with the contract block |
| **`scripts/gen-docs.mjs`** *(new row — the draft gave `docs/**` to R5-2 and the **generated** `COMMANDS.md`/`KEYS.md` to R5-4 but left the generator unassigned)* | **R5-4** (round 4 gave it to S4, whose successor R5-4 is) | R5-2 | the generator learns the `'agents'` `KeyContext` and the new command categories so `docs/COMMANDS.md` and `docs/KEYS.md` regenerate; R5-2's `docs/**` PR consumes its output and never hand-edits a generated file | **W5** |
| **`src/tui/plain.ts`** | **R5-4** (in R5-4's §9.1 cell) | R5-1, R5-2, R5-3, R5-5, R5-6 | every new surface's `--plain` rows route through the one formatter. R5-1: the `/who` rows and the resume card. R5-2: the `'[session]'` label branch. R5-3: `/context`'s block. R5-4: the agent rows. R5-5: the `[import]` items. R5-6: the picker's numbered twin. **This file is S5's in round 4 — round 4's `plain.ts` work lands first (§9.3 W0)** | W3 |
| **`src/tui/keys/bindings.ts`** | **R5-4** | R5-1 | R5-4 adds `KeyContext 'agents'` (`:12`, five members today; `KEY_CONTEXTS` `:15`), the eight `agents:*` rows, `global:paneFocus` on `Alt+A`, and makes the two pane-tab titles (`:72–73`) computed from `paneTabsFor(...)`. R5-1 adds the six picker-block rows for §2.8's card sub-state (`'cardOpen'`/`'cardClose'`/`'cardReplay'`/`'cardFresh'`/`'cardDiff'`/`'cardWho'`), scoped to `card !== null` so they do not take four more letters from the filter (`picker:delete` already owns bare `x` at `:136`). **`Ctrl+L` stays `global:repaint` (`:70`) and is not rebound** (D-AQ) | **W3**, with `keys/resolve.ts` |
| **`src/core/types.ts`** | **R5-2** (round 5's contract block only; in R5-2's §9.1 cell) | all six | §8.1 items 1–6, the `SessionActivityView` **and `SelfIdentityView`** interfaces, and the eight `contract 1.6 item` → `contract 1.7 item` renumberings (`:1048, :1785, :1820, :1827, :1849, :1900, :1903, :1983`, §8.1 item 10), **all in W0** — **together with the two `theme*.test.ts` two-line edits**, without which W0 does not compile (§8.1 item 2). Item 1 is a REQUEST that arrives as a **five-edit hunk** from the harness (§8.2 R1); item 5 is already on `main` (`CD §F`). Per `docs/DECISIONS.md`'s "harness-owned files touched by the TUI session arrive as hunks" rule | **W0** |
| **`test/pty/**`, `src/perf/**`** | **R5-2** | all six | one `.steps` file per new surface; `assertNoKeyBytes` called from every one; the `model-picker` composer series; the `who-bench` probe | **W5** |
| **`docs/**`, `README.md`, `CHANGELOG.md`, `completions/*`, `man/jevcode.1`** | **R5-2** (R5-4 owns the *generated* `COMMANDS.md`/`KEYS.md`) | every slot | §12, §13, the `docs/DECISIONS.md` entries, the `IMPORT-DESIGN`/`COORDINATION-DESIGN` doc fixes of §15 Q3 | **W5** |

### 9.3 Waves

**W−1 — rebase and re-verify (R5-2, half a day, before anything else).** This worktree is an **ancestor** of
`main`: `git merge-base --is-ancestor 2400a0c HEAD` → false, `d8490fa` → false. Rebase onto `main`, then re-read
the "built / not built" tables of §2.0, §3.0, §4.1, §5.0 and §6.0 and the four `budget/lines.ts` call sites of
§4.10, and post the diff. Gate **G-R5-11**. Every `file:line` in this document is as-seen on `r5-design`; several
are already stale against `main` by construction (contract 1.5, `meter.heldUsd`, the `decompose` stage). **No slot
starts W0 before this lands.**

**W0 — contract (R5-2 + every slot, half a day).** §8.1 items 1–6, `SessionActivityView`, `SelfIdentityView` and
the eight contract-comment renumberings in `src/core/types.ts`; **the two `test/unit/tui/theme*.test.ts` two-line
edits in the same PR** (without them `tsc --strict` fails on TS2741, §8.1 item 2); R1's five-edit harness hunk if
it has arrived. **The round-4 stub step is deleted**: the brief puts round-4 implementation before round 5, so
every slot imports the real `src/tui/{block/lines,fit,gutter}.ts`. §8.4's stub table is a contingency at
`__stub__` paths only, and its swap costs one import line per file (§14.2 #50). `tsc --strict` green, every fake
compiles. **Nothing else lands in W0.**

**W1 — pure modules, all six slots in parallel, offline, zero I/O.** R5-1 `session/peers.ts`,
`session/picker-lines.ts`'s fold-aware row builders; R5-2 `commands/target.ts` (**first — R5-1's `sessions who`
and R5-4's `/agent <slug>` both consume `resolveTarget`**), `peerZoneText`, the lease-conflict card builder;
R5-3 `context/lines.ts` (`ctxText`, the `/context` block), `resolveContextConfig`; R5-4 `agents/lines.ts` (the 16
row states and four cards, against fixtures), `pane/model.ts`'s `paneTabsFor`/`cycleTab`; R5-5 `config/imports.ts`
(the manifest reader and the 17 item builders), `import/lines.ts`, `import/reducer.ts`; R5-6 `models/lines.ts`,
`models/state.ts` (the picker reducer over `instantCatalogue()` fixtures) **and the eight two-provider shadow
tables of §6.3**, which are behaviour-neutral today and stop seven places drifting.

**W2 — renderer and CLI wiring, own files only.** R5-1 `cli/sessions.ts`'s thirteen new verbs and their `--json`
shapes; R5-2 `status/lines.ts` (its own `peers` segment), `dispatch.ts`, `toasts.ts`; R5-3 nothing (it is a pure
slot until W3); R5-4 `pane/agents.ts`, `keys/bindings.ts`, `Review.tsx`'s five branches; R5-5 `cli/import.ts`,
`import/Report.tsx`, the wizard step; R5-6 `cli/models.ts`, `models/Picker.tsx`, `login.ts`'s free verify.

**W3 — cross-slot requests, landed by the owner in one PR each.** R5-2 lands the whole of `status/lines.ts`
(its own rows plus R5-3's and R5-4's, `DROP_ORDER`, `StatusZones['dropped']` and the push order — one edit);
**R5-4 lands the shared React shell** (`App.tsx`, `Pane.tsx`, `useEngine.tsx`, `Picker.tsx`, `Console.tsx`,
`StatusLine.tsx`) as **one PR carrying R5-2's, R5-5's and R5-6's hunks verbatim — this is the PR four slots are
blocked on, so it is scheduled first in W3**; R5-4 also lands `keys/resolve.ts` and the `plain.ts` rows for every
slot; R5-5 lands `layout.ts`/`Overlay.tsx` and R5-6's `onboarding/lines.ts` row-5 hunk.

**W4 — the shared arrays, one commit each, last.** In this order:
`src/config/{types,defaults,validate,resolve}.ts` (R5-3, one PR — constraint (c)) → `src/cli/args.ts` +
`src/cli/main.tsx` (R5-6, one PR, the three `Command` members and their three `switch` arms) →
`src/tui/commands/registry.ts` (R5-2) → `src/cli/session.ts` (R5-1) → `src/session/index.ts` (R5-1). **Each lands only once every contributing slot's PR is open** (not merged) with its
exact row text posted, per `docs/DECISIONS.md`'s 2026-09-22 shared-file entry and TD4 §9.2's own precedent.

**W5 — gates, pty, perf, docs (R5-2).** The new `.steps` files, the twin sweep extension, the `model-picker`
composer series, the `who-bench` probe, `docs/TUI.md` / `docs/COMMANDS.md` / `docs/KEYS.md` / `docs/IMPORT.md` /
`README.md` / `CHANGELOG.md` / `docs/DECISIONS.md`, and one live capture per new surface on both providers (paid,
once). **No paid call in any unit or pty test.**

**Ordering constraints that are not negotiable.**
(a) `src/tui/commands/target.ts` lands **first in W1** — three slots consume `resolveTarget`.
(b) Round 4's `block/**`, `fit.ts` and `gutter.ts` (real or stubbed) precede every W1 builder that produces rows.
(c) **Relaxed, with a named carve-out (§14.2 #9).** The draft required the `context.*` schema rows, the resolver
**and** the `contextPolicy: rcfg.context?.()` call-site line in one PR — but the rows and the resolver are R5-3's
(`src/config/{types,defaults,validate,resolve}.ts`) while the call-site line is in `src/cli/session.ts`, whose
owner is **R5-1**, landing its own single end-of-wave PR. Two owners, two PRs, so the constraint was unsatisfiable.
The rule is now: **R5-3 owns the two `src/cli/session.ts` lines as an explicit exception row** — it lands them
itself, in its own W4 PR, and R5-1's `session.ts` PR rebases on top. (The alternative — "same wave, and the schema
rows do not merge until R5-1's PR is open with the exact hunk posted" — was rejected because it leaves the tree in
the dead-code state D-AI exists to prevent for however long the two PRs are in flight.) `EngineOptions.contextPolicy`
(`src/core/types.ts:1248`) is referenced nowhere in `src/cli/session.ts` today, and `ResolvedConfig.context?()`
(`:2076`) is never set by `src/config/resolve.ts` — both verified.
(d) `ConfirmRequest`'s four fields (R5) land **before** the agents tab consumes them (D-AM), proven by
`review.test.tsx`'s extended `it.each`.
(e) The `INDEX_KINDS` commit is the **last** commit of W4 (D-AS).
(f) **Restated (§14.2 #8).** The shadow-table **consumers** R5-6 genuinely owns (rows 3 and 4, and the new
`src/tui/models/**` call sites) land in **W1**; the seven cross-slot edits ride their owners' PRs at the waves
§6.3's table names (row 7 in W2, row 5 in W3, rows 1, 2, 6 and 8 in W4). **All of them precede the seven-provider
widening (R9/D-AP)**, so the widening is a union change against already-imported tables rather than eight
simultaneous edits. The draft's "rows 1, 2, 3, 5, 6, 7 and 8 land as one small commit in wave 1" was impossible:
five of those seven are in files whose owner lands a single end-of-wave W4 PR.
(g) **`src/tui/glyphs.ts` lands in W1**, before any slot's string builders — nine of §12's strings do not compile
without its new members (§14.2 #43).
(h) **R5-4's shared-React-shell PR is the first thing in W3.** Four slots' surfaces cannot be mounted until it
merges (§14.2 #2).

---

## 10. Tests per slot (vitest `unit`, offline; pty `--mock`, hermetic; perf under a real pty; live paid once)

**R5-1 — session state, the picker, the index.**
*unit* `session/peers.test.ts`: `peerViewOf` over 12 fold fixtures (0 peers, 1 live, 1 stale, 1 live + 1 exclusive
lease, a cloned device, an ignored device, a bench row, a gone row inside and outside the 10-minute window) —
every field of `PeerView` asserted, **and a property test that no output string contains a path or a pid**.
`session/picker-lines.test.ts`: the resume card's eight branches (fresh · replayable · targets-moved · imported ·
crashed · live-elsewhere · taken-over · forked-unverified), each at 40/80/120 columns, with the `ctx` cell present
and **omitted** (§7 row 38). `session/index.test.ts`: the merged `INDEX_KINDS` — **imported, which is only possible because the D-AS commit
exports it and re-types it `readonly IndexKind[]`** (§8.1 item 9, §14.2 #18/#55) — has exactly the 15 expected
members; no kind collides; every `IndexLine` arm round-trips through the writer and the fold; **a pre-round-5
`pause` line with no `by` folds and reads back `by: 'self'`, and a pre-round-5 `run:start` with no
`parentSessionId` reads back `null`** (§2.6, §14.2 #17); a 200,000-line index folds in < 100 ms (the existing
gate). `session/peers.test.ts` also covers the two new mappers: `activityView` preserves **all five** `Liveness`
members including `'stale-reused-pid'`, carries `authority` and `subwork`, and **`selfView` never emits
`hostKey`** (a property test over the serialised JSON, §7 row 61). `cli/sessions.test.ts`: all 17 verbs over an
injected I/O seam, each with its `--json` snapshot; `gc --device` resolves a label **past** the 16-device fold cap
(§7 row 14); `unlock` prints all six `LockReplace` reasons **and asserts that the three replaceable ones emit no
`detail60`** (`records.ts:807–809`) but do emit the CLI's own S38a sentence (§14.2 #26). A new
`session/publish.test.ts`: the heartbeat writer starts only after a resolved `firstFrame()` promise, stops in the
`finally`, and the claim is minted **after** `claimRefusal` returns null (§2.14).
*pty* `r5-who.steps` (three peers + a bench + a crashed row at 80×24, then `resize 40 24`, then `--ascii`).
*perf* `who-bench.test.ts`: `/who` over a 200-row fold builds in < 20 ms (gate G-R5-4).

**R5-2 — commands, targets, messaging, the status zone.**
*unit* `commands/target.test.ts`: a table over 40 inputs — exact run id, exact session id, 8-char prefix, 7-char
prefix (refused), `device:<label>`, exact title, title prefix, a title equal to `all`, a title equal to `self`, an
ambiguous prefix listing ≤ 5 candidates, an unknown target — asserting the resolution **order**, not just the
result. `status/lines.test.ts`: the `peers` segment at every count combination and its absence at 0/0/0; **the heads-up
clause present at 100 and dropped at 99/80, and the whole segment absent at 79** (`HEADSUP_MIN_COLUMNS`,
`PEERS_MIN_COLUMNS`, §14.2 #28); **the `ctx` cell's two rungs — `ctx 41%` at 80–99 and the full form at ≥ 100**
(§14.2 #38); **`rightZoneSegments`'s push order asserted as a list**, so F-51 and F-55 cannot drift apart again
(§14.2 #45); the drop order at columns 40…200 asserting `ctx` drops after `git` and before `peers`, and that
`'agents'` is **never** dropped; `StatusZones['dropped']` accepts `'ctx'`/`'peers'`; the `--ascii` twin of
`⇄`/`✉` through `glyphSet({ ascii })`. `glyphs.test.ts`: `asciiTwins()` is **injective** over the nine new
members — the test that would have caught S3's `◌`→`o` against S60's `◌`→`.` (§14.2 #43).
`commands/dispatch.test.ts`: `/pause`, `/pause now`, `/pause <target>`, `/pause all`, `/end`, `/end now` each
produce the right `CommandAction` and the right `PauseOptions`/`EndOptions`; `/end`'s confirm row's Enter is
**inert** (the TD4 §4.5 invariant). `blocking/lines.test.ts`: the lease-conflict card at four rungs (skipped until
R1 lands, with an explicit `it.skip` naming the request).
*pty* `r5-pause-end.steps` (pause at a boundary, pause now, end with the confirm, at 80×24 and 40×24);
`r5-message.steps` (a `request` row that persists, a `headsup` toast that does not).

**R5-3 — context meter and compaction.**
*unit* `context/lines.test.ts`: `ctxText` over 200 random `ContextUsage` values asserting the string equals
`formatMeter(u)` with the glyph substituted, and the ascii form contains no `·`; the three empty states
(§7 rows 35–37) each produce their own distinct sentence; the amber/red crossing fires **exactly once per
threshold per run** over a 500-tick property test; `/context`'s block at 40/80/120 with the three-source join,
including the `outputEvicted` case (§7 row 43's sibling — a pointer that must not be printed again).
The `off` branch of `/compact` is its own case: with `status().context.compaction === 'off'` the answer is S58a
and **never** `nothing to compact` (§3.3, §14.2 #15). A resume above an already-crossed threshold re-announces
(§7 row 98). `config/context.test.ts`: every one of the five rows resolves from flag > env > `.env` > config file
> default;
`ResolvedConfig.context()` is **always set** after `resolveConfig` (the claim at `types.ts:2071–2075` becomes
true); `EngineOptions.contextPolicy` is non-undefined at every `createEngine` site.
*pty* `r5-context.steps` (`/context` then `/compact` under `--mock` at 120×40, and the `nothing to compact` branch).

**R5-4 — the agent tree.**
*unit* `agents/lines.test.ts`: **all sixteen** `AgentState` values produce their exact word (a table test keyed off
the union, so a new member fails to compile); the four cards at 40/80/120; the `base moved` branch (§7 row 49);
the worktree-gone-branch-present branch (§7 row 50); a property test that no row is ever omitted from
`agentRows(rows)` regardless of width. `pane/model.test.ts`: the **existing** `:165–167` two-argument `cycleTab` cases stay green **and unedited** —
which is true only because the default binds to the four-member `PANE_TABS`, so the test file is also the
regression guard for §14.2 #1/#31; a new case asserts `cycleTab('s', 1, PANE_TABS_WITH_AGENTS) === 'a'`;
`paneTabsFor(false)` excludes `'a'` and `]`/`[` skip it; `TAB_TITLE` is total; **the two tab strips at `:355`
and `:377` are computed, asserted at wide and narrow with and without delegation**. `cli/agents.test.ts` also
asserts `COMMANDS` contains `'agents'` and that `src/cli/main.tsx`'s switch has the arm — the check that makes
the verb reachable (§14.2 #7). `keys.test.ts`: the `agents` rung resolves `p`/`t`/`d`/`k`/`l`/`+` **only** when
`paneFocus && tab === 'a'`, is below Picker and above Composer, and `Alt+A` is **refused with a non-empty draft**
(§7 row 99).
`review.test.tsx`: the `it.each` extends from n = 8 to n = 2 with `title`/`headline`/`body`/`badge` present, and
the property **no rendered row contains any substring of `risk` or `proposal`**; the `split: 'auto'` rule holds for
3 research + 1 code (§4.6). `agents-caps.test.ts`: a resumed child counts against `maxAgents` via the fold, never
a counter (§7 row 48). `cli/agents.test.ts`: `jevcode agents list --json` over fixtures, engine never started.
*pty* `r5-agents-tab.steps` (the tab hidden with no delegation, shown with fixtures injected, `]`/`[` skipping).

**R5-5 — the import surface.**
*unit* `import/reducer.test.ts`: the five-group default view from a `summarisePlan` fixture; `y` applies exactly
`applicableRows`' output and **never** a `class === 'secret'` row even when one is planted in an applicable group
(§7 row 58); expand/collapse; the review sub-view. `import/lines.test.ts`: all 17 `[import]` strings at two glyph
sets, imported from `config/imports.ts` and never re-declared (§13). `config/imports.test.ts`: the tolerant `v: 0`
reader upgrades in memory and does not rewrite (§7 row 54's sibling, IM row 70). `cli/import.test.ts`: every flag,
every exit code, the five twins, `--yes` refusing credentials, `--resume`/`--undo` id validation through
`isImportId`. `onboarding/reducer.test.ts`: the `'import'` step appears only when `probe` returns a non-empty
result, is skipped past the 50 ms deadline, and `3 never` writes `seen.import` once.
*pty* `r5-import-overlay.steps` (24×80 → 12×60 → 40×120 mid-overlay); `r5-import-ctrlc.steps` (the three different
Ctrl-C behaviours of §7 row 59).

**R5-6 — provider, model picker, key setup.**
*unit* `models/state.test.ts`: the picker reducer over `instantCatalogue()` — first paint is synchronous and
non-empty with **zero** awaits; rows replace in place as fixtures settle; a stale provider keeps its rows.
`models/lines.test.ts`: the row's composed drop order at 40/80/120 (capabilities → output → context → provider),
asserting no row is ever cut mid-grapheme; every `ModelsError.kind` produces its `errorLabel` row; the numbered
`--plain` twin and its one-shot prompt; the SR line coalesced ≤ 1 per 400 ms. `models-search.test.ts`: the
did-you-mean list; routing variants behind their standard route on the empty query but findable by name.
`cli/models.test.ts`: `list`/`search`/`refresh` and their `--json` shapes, engine never started.
`config/provider.test.ts`: all seven ids resolve their env names **including** `GOOGLE_API_KEY` and
`MODEL_API_KEY` (the live bug of §6.3 row 1); `validate.ts` accepts all seven once R9 lands and rejects a
non-id. `login.test.ts`: the free `verifyProvider` path, the three outcome strings, Ctrl-C aborting only the
in-flight request.
*pty* `r5-model-picker.steps` (open at 120×40, type `glm`, `resize 40 24`, Enter, `--ascii`); every scenario calls
`assertNoKeyBytes`.
*perf* the `model-picker` composer series: 200 keystrokes over a 500-model catalogue, p95 < 16 ms (gate G-R5-5).

**Shared, landed with W4 and W5 (R5-2).** `registry.test.ts`: the final row count (56), no duplicate `name` or
alias across all six requests, every row has a `--plain` note and a `category`, and **no row is a dead pointer** —
every command named in another command's help text or in `docs/COMMANDS.md` resolves. `contract.test.ts`: the
header order (`1.1, 1.2, 1.2, 1.3, 1.4, 1.7, 1.8`, ascending after 1.4); every `context.*`/`coordination.*`/
`orchestrate.*`/`import.*`/`memory.*` name in this document has a `SETTINGS` row; no two round-5 slots claimed the
same key. `r5-identity.test.ts`: for every new surface, the TUI row, the `--plain` row and the `transcript.log`
row are equal under the §5.3 normaliser, with each declared truncation clause asserted rather than skipped (§13).

---

## 11. Gates — every existing gate stays; ten new numbered rows

**Every gate of TD3 §9 and TD4 §11 stands and is re-run as a regression.** The "round 5" column says what changes;
a blank means unchanged. The ten new rows are numbered **G-R5-1 … G-R5-10** so a slot can cite one.

| Gate | Threshold | Round 5 | Evidence |
| --- | --- | --- | --- |
| first frame | cold p95 < 300 ms at 40×120 / 24×80 / 8×40; zero network; zero file I/O | **strengthened — G-R5-1**, widened by the review (§14.2 #5, #14, #35): the assertion is over `src/cli/main.tsx`'s **transitive static** import graph and names **nine** modules, not three — `provider/registry.js`, **`provider/openrouter.js`**, `models/list.js`, **`models/providers.js`**, **`models/index.js`**, **`coordination/index.js`**, `coordination/ledger.js`, **`import/index.js`** and **`orchestrate/index.js`**. A `await import()` inside a function body passes by construction; an `import type` erases. Plus: `LedgerHandle.open()`, the heartbeat writer's **first write** (§2.14) and `probe()` all provably after `firstFrame()` | `perf/first-frame.ts`; `JEVCODE_ASSERT_NO_NETWORK`; new `import-graph.test.ts` |
| zero clears outside shrink resizes | 0 | re-run with the two new overlays (`import`, `models`) in the resize matrix | `render-lag.ts` `CLEAR_RE` |
| no `ESC[3J` ever | 0 | | `render-lag.ts`, `run-smoke.sh` |
| no frame taller than the terminal | `paintedRows ≤ rows` | re-run with the agents tab at 16 rows and the model picker at 500 rows of source data | `perf/pty.ts` |
| lag p95 net < 5 ms | at `JEVCODE_MOCK_STEP_MS=200` | **re-measured** with the fold watcher running: **G-R5-2** — a fold change must not cost more than one dynamic frame, and 200 fold changes in 10 s must not exceed maxFps + 1 | `render-lag.ts` + a new fold-storm scenario |
| composer keystroke → frame | p95 < 16 ms, max < 50 ms | **plus one series — G-R5-5**: `model-picker`, 200 keystrokes over a 500-model catalogue at 120×40, **gated** | `composer-latency.ts` |
| dynamic fps during a run | ≤ maxFps + 1 per 1-s bucket | **plus** the agents tab open with 12 rows updating | `render-lag.ts` |
| idle animation (`idle-frames`) | ≤ 4 frames/s peak, mean ≤ 2/s | **plus** a `peers` case: two live peers beating every 2 s must not raise the idle frame rate at all (the zone re-renders on fold change, not on a timer) — **G-R5-3** | `src/perf/idle-frames.ts` |
| line identity | `transcript.log` == `--plain` == TUI | **strengthened**: every round-5 surface joins `r5-identity.test.ts` with its declared truncation clause **asserted**, never skipped (§13) | `r5-identity.test.ts`, `twins.pty.test.ts`, `plain.test.ts` |
| block width | no static row exceeds the terminal width at 24×20 … 40×120 | **extended** to `/who`, `/context`, `/compact`, the agents tab, the import overlay, the model picker and every new card — **G-R5-6** | `commands-width.steps` + `r5.pty.test.ts`; a unit sweep over columns 1…200 |
| review invariants | only `y` approves; Enter inert; no default | **plus**: the manifest confirm's five branches are row-count-preserving at n = 8…2, and the property "no rendered row contains a substring of `risk` or `proposal`" — **G-R5-7** | `review.test.tsx` |
| keys never in logs or frames | 0 key bytes | **extended** to device keys, claim HMACs and imported credentials: `assertNoKeyBytes` is called from **every** new pty scenario — **G-R5-9** | `test/pty/round3.pty.test.ts:54`'s helper, new call sites |
| no new runtime dependency | `dependencies` = `ink` + `react` | | `pack:check` |
| index fold | < 100 ms at 200,000 index lines | re-run after the seven new kinds and the two new fields | `session/index.test.ts` |
| — | — | **G-R5-4 (new)**: `/who` builds in < 20 ms over a 200-row fold, and `peerZoneText` in < 1 ms | `who-bench.test.ts` |
| — | — | **G-R5-8 (new)**: the settings-collision lint — no two round-5 slots claim the same `SettingName`, and **every key in `docs/ORCHESTRATION-DESIGN.md` §6.4's table (`:1427–1461`, 34 keys, enumerated in §4.8) plus every `context.*`/`coordination.*`/`import.*`/`memory.*`/`seen.*` name of §3.6 and §8.1 item 7** has a `SETTINGS` row. **The authority is OR's table, not "every name this document mentions"** — the draft's wording was vacuous for 32 of the 34 keys (§14.2 #19) | `contract.test.ts` |
| — | — | **G-R5-10 (new)**: the shared-array identity test — `INDEX_KINDS` (**imported**, which the D-AS commit's `export` makes possible) has exactly its 15 expected members, `COMMANDS` has exactly 56 rows with no duplicate name or alias, and **`Command` has exactly its 16 members, the three new ones named literally: `'import'`, `'models'`, `'agents'`** (§14.2 #7 — "its expected members" would have passed with `agents` absent, which is precisely the defect). The `OverlayKind`/`SegmentId`/`DROP_ORDER`/`StatusZones['dropped']`/`PaneTab`/`KeyContext`/`UiLabel`/`GlyphSet`-nine arrays are asserted the same way. This is the gate that catches two slots racing one array (§7 row 90) | `session/index.test.ts`, `registry.test.ts`, `args.test.ts`, `layout.test.ts`, `status/lines.test.ts`, `glyphs.test.ts` |
| — | — | **G-R5-11 (new, W−1)**: the rebase-and-re-verify sweep. After the rebase onto `main`, every "built / not built" row in §2.0, §3.0, §4.1, §5.0, §6.0 and every `file:line` in §8.2 is re-read and the diff posted. This worktree is an ancestor of `main` (`2400a0c` and `d8490fa` are both **not** ancestors of HEAD), so contract 1.5, `meter.heldUsd`, the four `sessionRemainingUsd` call sites and `StageName 'decompose'` are already stale here (§14.2 #32, #36) | a checklist in the W−1 PR body, plus `contract.test.ts`'s header-order case |

**Two measurement caveats carried forward.** (a) The fold-storm scenario (G-R5-2) has never been run — the fold
watcher has no consumer today — so its threshold is a *design* threshold and must be re-baselined once R5-1's
`sessions who` is live; if 200 fold changes in 10 s turns out to be unrealistic, the number moves but the shape
("a fold change costs at most one dynamic frame") does not. (b) The model picker's 500-row catalogue is the
bundled snapshot's size today; a live OpenRouter load is larger, so G-R5-5 is re-run once against a real
`loadCatalogue` result before the gate is signed off.

---

## 12. Strings — every user-visible string round 5 adds, once, with its twins

`--ascii` substitutes per TD §14.1 through **`glyphSet({ ascii })`** (`src/tui/glyphs.ts:216` — the parameter is an
options object `{ ascii?: boolean; screenReader?: boolean }`, and `ascii` wins over `screenReader`, so the SR twin
of an `--ascii` run is the ASCII set; §14.2 #53). "SR" is the screen-reader
form; where it is identical the cell says *same*. **No string in this table replaces a landed one** (N6): every
TD3/TD4 glossary entry is untouched, and the compaction notice (`src/loop/engine.ts:3567`) is listed as *landed,
unchanged* so nobody re-pins it.

### 12.1 Coordination

| # | String (verbatim) | `--plain` | SR | `--ascii` |
| ---: | --- | --- | --- | --- |
| S1 | `● mbp  main@3f9a2c1  step 7/40 propose  jev+llm  ctx 41%  $0.12/2.00  editing src/loop/engine.ts (+1)  lanes 2 · samples 3  beat 2 s` | same row, one line | **completed (§14.2 #60 — the draft's twin dropped `jev+llm` and `lanes · samples`, giving the SR user strictly less than the sighted one, against §7 row 82's own rule):** `mbp, live, main at 3f9a2c1, step 7 of 40 propose, mode jev plus llm, context 41 percent, spent 12 cents of 2 dollars, editing 1 file, 2 lanes and 3 samples, last beat 2 seconds ago` | `*` for `●`, `-` for `·` |
| S2 | `● mbp  bench glm-vs-jev  12/30 tasks live 4 · lanes 8` | same | `mbp, bench glm-vs-jev, 12 of 30 tasks, 4 live, 8 lanes` | `*`, `-` |
| S3 | `◌ stale (last beat 4 m ago) · crashed during step 8 (propose)` | same | `stale, last beat 4 minutes ago, crashed during step 8 propose` | **`.` for `◌`** (corrected, §14.2 #43 — the draft said `o`, but S60 maps `◌`→`.` and `○`→`o`, and `asciiTwins()` is a one-to-one first-wins map, `src/tui/glyphs.ts:223–232`), `-` |
| S3a | `◌ stale (last beat 4 m ago, pid reused) · sessions unlock <id8> if that process is gone` — the **`'stale-reused-pid'`** `Liveness` member (`src/coordination/types.ts:403`), which the draft's four-member view could not represent (§14.2 #11) | same | `stale, last beat 4 minutes ago, the process id was reused` | `.`, `-` |
| S3b | `○ gone 6 m ago · crashed during step 8 (propose)` — the `'gone'` row, distinct from stale (§14.2 #58) | same | `gone 6 minutes ago, crashed during step 8 propose` | `o`, `-` |
| S4 | `● … (no beat 4 m — hung?)` | same | `live but no beat for 4 minutes, possibly hung` | `*`, `...`, `--` |
| S5 | `? unknown (not synced yet)` | same | same | same |
| S6 | `⇄ 2 live · 1 heads-up · ✉ 1` | same | *(not announced live; a 0 → ≥1 change announces)* `1 message from mbp — /inbox reads it` | `<> 2 live - 1 heads-up - mail 1` |
| S7 | `who · 3 live, 1 gone` | same | same | same |
| S8 | `no other jevcode is working here — /who --all includes sessions gone more than 10 minutes` | same | same | same |
| S9 | `<n> devices past the fold cap — jevcode sessions gc lists them` | same | same | same |
| S10 | `⚠ hung` · `⚠ skewed <n>s` · `⚠ forked` · `taken over` · `no lock` · `ignored` · `unverified` · `⚠ cloned` | same | spoken as words, comma-joined | `!` for `⚠` |
| S11 | `taken over by mbp at 14:02 (claim 4); /resume --force-takeback re-takes it` | same | same | same |
| S12 | `mbp claims 4 (unverified) — ignored; sessions pair to make it count` | same | same | `--` |
| S13 | `error: run <id> is also live on <label> (claim 4 supersedes 3) — stopped to avoid a double writer` | same | same | `--` |
| S14 | `run <id> also appears live on mbp (unverified) — [c] continue here  [q] stop` | same | `run <id> also appears live on mbp, unverified. Press c to continue here, q to stop.` | `--` |
| S15 | `claim epochs for this run reached the bound (1e9); nothing can take it over — start a new run from this state` | same | same | `--` |
| S16 | `ignored an out-of-range unqualified claim from <label> — the new claim is <n>` | same | same | `--` |
| S17 | `pausing · step 8 commits first (propose, 41 s, ~40 s p50 left) · Esc Esc aborts · Ctrl-X Ctrl-P pauses now` | same | same | `-` |
| S18 | `paused now at step 8 (propose): proposal kept — /resume replays it` | same | same | `--` |
| S19 | `paused after step 7 — /resume continues, or type a follow-up` (+ ` · 3 steers pending` · ` · mbp is live on this repo`) | same | same | `--`, `-` |
| S20 | `paused at the <kind> pane after step 7 — /resume retries it` | same | same | `--` |
| S21 | `pausing · execute finishes first (12 s)` | same | same | `-` |
| S22 | `resumed at step 8 (replayed the paused proposal; risk re-checked)` · `resumed at step 8 (fresh: targets changed)` · `resumed here from mbp (imported 7 steps; undo unavailable)` | same | same | same |
| S23 | `targets changed since the proposal (store.ts by mbp@8bc0d11) — replay unavailable` | same | same | `--` |
| S24 | `the paused proposal and its samples stayed on <label> — resuming starts a fresh step` | same | same | `--` |
| S25 | `crashed 3 m ago during step 8 (propose, 41 s in) — step 8 restarts` | same | same | `--` |
| S26 | `● live on mbp — [w] watch (read-only tail) · [t] tell · [p] ask to pause · [Esc]` | same | spoken key list | `*`, `--`, `-` |
| S27 | `end this session: [y] at step boundary  [Y] now  [n] stay` (rungs: `end session: [y] at step end  [Y] now  [n] stay` · `end: [y] step end  [Y] now  [n] stay` · `y end · Y now · n stay`) | same | `End this session? Press y to end at the step boundary, shift-Y to end now, n to stay.` | `-` |
| S28 | `ended session "<title>" after step 7 — /resume <id> --force reopens` | same | same | `--` |
| S29 | `already ending — /resume <id> --force reopens it` | same | same | `--` |
| S30 | `relocated to worktree <slug> (branch jevcode/<slug>) — /worktree back merges or hands off` | same | same | `--` |
| S31 | `[session] mbp: committed 3f9a2c1 on main — engine.ts, store.ts` | same | `Session message from mbp: committed 3f9a2c1 on main, engine.ts, store.ts` | `--` |
| S32 | `mbp asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore` | same | spoken | `--` |
| S33 | `heads-up: editing src/loop/engine.ts (+1) for: <task60>` | same | same | same |
| S34 | `mbp is waiting for src/x.ts — commit and move on when you can` | same | same | `--` |
| S34a | `that message looks like it contains a key — [y] send anyway  [n] edit  [Esc] cancel` *(the `/tell`/`/headsup`/`/request` body gate, §2.9, §7 rows 92–94; `[y]` sends the **redacted** text, never the raw key)* | same | `That message looks like it contains a key. Press y to send the redacted text, n to edit, Escape to cancel.` | `--` |
| S35 | `unpaired mbp — it can no longer steer, stop, resume, end or import your runs. It still holds this device's key: run 'jevcode sessions pair --rotate' to invalidate it everywhere.` | same | same | `--` |
| S36 | `this device took a new id (<id8>) and a new key — run 'jevcode sessions pair' with each peer again` | same | same | `--` |
| S37 | `device id <id8> is also live on another machine — run 'jevcode sessions pair --rotate' to invalidate the shared key` | same | same | `--` |
| S38 | `machine id unavailable — two machines sharing this home would share one device id` | same | same | `--` |
| S38a | the three **replaceable** `LockReplace` reasons, which carry **no `detail60`** (`src/coordination/records.ts:807–809`, §2.10, §14.2 #26) — `no lock file — taking it` · `the lock's pid is gone — taking it` · `the lock is from another boot — taking it` | same | same | `--` |
| S39 | `another session holds src/loop/engine.ts (mbp, step 12, 3 m)` + `[w] wait for it   [r] read-only session   [t] relocate to a worktree   [q] quit` (rung: `w wait · r read-only · t worktree · q quit`) | same | spoken key list | `-` |
| S39a | `the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit` *(the holder turned `stale` while `[w]` was armed, §2.11, §7 row 95)*, and the armed form `[w] waiting 2m14s — Esc gives up` *(§7 row 96)* | same | spoken | `--`, `-` |
| S39b | `took a lease left by a session that is gone (mbp, 14:02)` *(a `gone` holder is not a conflict; no pane opens, §7 row 97)* | same | same | `--` |
| S39c | `7 uncommitted files, 2 inside an agent's slice — [c] commit them  [s] stash them  [x] cancel the land` *(the `land-preflight` pane, `Engine.land(input, ask?)`'s `[c]/[s]/[x]`; `ask` absent ⇒ `[x]`, `CD §F`)* | same | spoken | `--` |
| S40 | `import run <id> from mbp#3f9a (host MacBook-Pro.local) — [i] import  [Esc]` (+ ` (unverified)` pre-pairing) | same | spoken | `--` |
| S41 | `origin not fully synced yet (step N row missing)` | same | same | same |
| S42 | `watching <runId> — tailing transcript.log` · `watching mbp · updates every 15 s + sync lag` | same | same | `--`, `-` |
| S43 | `"all" is a reserved target — the session titled "all" is <id8>` | same | same | `--` |
| S44 | `<n> sessions match "<prefix>" — <id8>, <id8>, <id8> …` | same | same | same |
| S45a | `/pause with no target needs a live run — /pause <target> asks a peer, any time` *(hand-written; `availabilityError` cannot express a per-form rule, §2.6, §14.2 #16/#39)* | same | same | `--` |
| S45b | `nothing is running to end — /end <target> ends a peer's run, jevcode sessions end <id> ends one from the shell` | same | same | `--` |

**Kept from TD4 §12, unchanged and re-used by §2.4:** `peers · <n> here, <m> stale` ·
`no other jevcode is working in this workspace` · `the peer registry is not available in this build` ·
`another jevcode is working in this workspace (started <t> ago) — /peers lists them` ·
`[w] wait for it   [r] read-only session   [q] quit`
**Superseded, not kept (§0, §2.4, §14.2 #10):** TD4's status segment **`<n> here` / `<n> stale`** — the round-5
segment is S6 (`⇄ 2 live · 1 heads-up · ✉ 1`), because it now carries unread-message counts; and TD4 §7.10's
**per-peer kv rows** (`workspace`, `started <t> ago`, `<state>`), which `PeerView`'s four scalars cannot produce
and which `/who` (S1–S5) answers instead. The draft pinned two different strings for one segment / `[c] continue`.

### 12.2 Context and compaction

| # | String (verbatim) | `--plain` | SR | `--ascii` |
| ---: | --- | --- | --- | --- |
| S45 | **two rungs (§3.1, §14.2 #38):** `ctx 41%` at 80–99 columns · `ctx 41% · 6 files · 12 steps` at ≥ 100 (the long form is `formatMeter`'s, `src/loop/context/meter.ts:109–113`; the short form is built from `u.pct` directly, never by truncating the long one) | same | *(the status line is not announced; see S47)* | `ctx 41% - 6 files - 12 steps` |
| S46 | `ctx 87% amber · /compact now` · `ctx 96% red · /compact now` — these **replace** the whole cell at both rungs, they do not append (§3.1) | same | — | `-` |
| S47 | *(the one-time crossing notice, through `engine.annotate()`)* `context at 87 % of the budget (amber) — /compact folds the history now` | same | same | `--` |
| S48 | `context · step 12 · relaxed · code compaction` | same | same | `-` |
| S49 | **corrected to the as-built output (§14.2 #37):** `budget 70k chars of the 128k-token window (est. $0.014 per step)` · `budget 96k chars — capped by the $2.00 run cap at 40 steps (est. $0.014 per step)` · `budget <N> chars — capped by the <M>-token model window` · `budget <N> chars — the floor` · `budget <N> chars — the ceiling` (all five from `formatBudget`, `src/loop/context/meter.ts:95–107`; the default arm is `:105`). The draft pinned `budget 70k of 128k window (55 %)`, which `formatBudget` never returns — no `(55 %)`, and the word `chars` is present — so the §13.4 anchor test and the `r5-identity` gate would have failed on it. **If a percentage is wanted it is a TUI-added row, not a `formatBudget` output**; §3.2's body block is corrected to the as-built string | same | same | `--` |
| S50 | `recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)` (from `formatRecentSteps`, `meter.ts:89`) | same | same | same |
| S51 | `prompt build 41 ms · file refresh 6 ms` | same | same | `-` |
| S52 | `summary at step 8 · 3 compactions · last 14:02` | same | same | `-` |
| S53 | `files in view · 6` and per-file `<path>  <bytes>  read at step 4 · edited step 6 · pinned by you` | same | `<spoken path>, 41 kilobytes, read at step 4, edited step 6` | `-` |
| S54 | `no run is live — /context reports the run's prompt budget` | same | same | `--` |
| S55 | `this run does not build a relaxed context (<mode>) — /context is empty` | same | same | `--` |
| S56 | `no prompt built yet — /context fills in at the first step` | same | same | `--` |
| S57 | `nothing to compact — only the newest step is in history` | same | same | `--` |
| S58 | `this run does not build a relaxed context (<mode>) — /mode jev-on builds one` *(replaces the draft's `— /context is empty` / `— nothing to compact`: for the **default** mode `llm-jev` this is the state a fresh install lands in until §8.2 R13 ships, so the sentence must name the escape, §1.1, §3.2)* | same | same | `--` |
| S58a | `compaction is off for this run (context.compaction) — jevcode config set context.compaction code turns it on` *(the fourth `/compact` branch, checked **first**; `src/loop/engine.ts:1520` returns with no status emit, so without this row the user is told S57, which is a falsehood — §3.3, §7 row 42a, §14.2 #15)* | same | same | `--` |
| S59 | *(landed, unchanged — do not re-pin)* `compaction: <before> → <after> prompt chars (code); <n> steps folded into the summary at step <s> (<why>)`, `src/loop/engine.ts:3567` | same (already identical in all three sinks) | same | `->` |

### 12.3 The agent tree

| # | String (verbatim) | `--plain` | SR | `--ascii` |
| ---: | --- | --- | --- | --- |
| S60 | the 16 row-state words of §4.2 (`queued` … `failed to start (<code>)`) | same | spoken as written | glyph column substitutes `○ ◌ ● ⏸ ⚠ ✓ ⟳ ✗ ↻ −` → `o . * = ! + ~ x @ -`. **This mapping wins and S3 is corrected to match** (§14.2 #43): `asciiTwins()` (`src/tui/glyphs.ts:223–232`) is a one-to-one map keyed by the unicode glyph, first entry wins, so `◌` cannot be both `o` and `.` |
| S61 | `agents 3 · ✓1 ● 1 ⏸1 · $0.41/0.90 · dock ✓` | same | `3 agents, 1 landed, 1 running, 1 paused, 41 cents of 90` | `-`, `+`, `*`, `=` |
| S62 | `agents 2/3 ✓1 ✗0 · $0.41/0.90 (+$0.06)` | same | spoken | `-`, `+`, `x` |
| S63 | `3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test, npm run typecheck` | same | spoken | `-` |
| S64 | `⚠ your checkout has 7 uncommitted files; 2 of them (src/tui/Pane.tsx, src/loop/engine.ts) are inside an agent's slice — /land will ask you to commit or stash those two before it merges` | same | same | `!`, `--` |
| S65 | `no risk dimensions on this card — this is a proposal, not an action` | same | same | `--` |
| S66 | `delegated at step 11 — 3 agents starting · /agents (Alt+A) · Esc pauses the tree` | same | same | `--`, `-` |
| S67 | `split declined; continuing single-threaded (the reason reaches the next step)` | same | same | same |
| S68 | `pause this session: [y] tree (3 agents at their next step)  [Y] tree now  [t] this run only  [n] stay` | same | spoken | same |
| S69 | `abort 3 agents too? [y] all  [t] this run only  [n] cancel` | same | spoken | same |
| S70 | `3 pause requests sent · 1 acked · 2 pending (they finish their step)` | same | same | `-` |
| S71 | `3 agents live: [k] keep them running (they keep spending) · [e] end them · [n] stay` | same | spoken | `-` |
| S72 | `delegated: 3 agents running; jevcode agents list follows them` | same | same | same |
| S73 | the per-agent verb lines of OR §4.8: `pausing tui-rows · step 4 commits first (propose, 41 s)` · `paused tui-rows now at step 4 (propose): proposal kept — resume replays it` · `resumed tui-rows at step 5 (replayed the paused proposal; risk re-checked)` · `steered test-fixture (1 queued for its step 4)` · `tui-rows cap $0.30 → $0.50 (session $1.43/2.00) — resumed` | same | same | `-`, `--`, `->` |
| S74 | `test-fixture needs approval: patch test/unit/store.test.ts (risk 0.52) — [Enter] review · [d] decline · [q] leave it parked` | same | spoken | `--`, `-` |
| S75 | `landed fix-store into jevcode/dock-a2fee9c1 @8bc0d11 · npm test ✓ (412) · typecheck ✓` | same | same | `-`, `+` |
| S76 | `fix-store not landed: removed 4 assertions in test/unit/store.test.ts — /agent fix-store land --anyway (twice) overrides` | same | same | `--` |
| S77 | `fix-store conflicts with tui-rows in src/checkpoint/store.ts (lines 361–383) — kicked (1 of 1)` | same | same | `--` |
| S78 | `dropped test-fixture (branch jevcode/test-fixture kept, 1 commit)` | same | same | same |
| S79 | `tui-rows: no progress for 11 m (same step 4, no files changed) — [p] pause · [k] kick · [x] drop` | same | spoken | `--`, `-` |
| S80 | `3 agents: 2 landed, 1 parked · dock verified · /land merges it here` | same | same | `-` |
| S81 | `adopted 3 agents of run 2026…-rpywkq2v (2 running, 1 parked) — /agents` | same | same | `...`, `--` |
| S82 | `base moved 3f9a2c1 → 9d21ee0 (2 commits by you) — [r] rebase the 3 agents · [s] stage on the old base · [f] forget` | same | spoken | `->`, `--`, `-` |
| S83 | `[n] recreate from jevcode/<slug>` | same | spoken | same |
| S84 | `run $0.12 · agents $0.31 (3 runs) · session $0.43/2.00 · held $0.29 · free $1.28` | same | spoken | `-` |
| S85 | `<verb> is not available in this build — no agent is running` | same | same | `--` |
| S76a | `step 7 landed 3 agents — /undo reverts the merge, /rewind cannot cross a land` *(`src/undo`'s `landedUndoOffer` / `rewindRefusal`, `CD §F` to-do 5, §4.5)* | same | same | `--` |
| S86 | the computed binding titles `next pane tab (d → p → t → s, + a while delegating)` / `previous pane tab; opens a collapsed panel`, and the two computed **strips** `[d]ecisions [p]lan [t]ime [s]ynth [a]gents` (wide) / `[d] [p] [t] [s] [a]` (narrow) — the landed grammar at `src/tui/pane/model.ts:355`, `:377`, extended, **not** F-54's earlier `d p t s [a]` form (§14.2 #31) | same | same | `->` |
| S86a | `finish or clear the line first — Alt+A then focuses the agents tab` *(focus is refused with a non-empty draft, the same `when: 'empty draft'` guard `global:paneNext` carries at `src/tui/keys/bindings.ts:72`; §4.3, §7 row 99)* | same | same | `--` |
| S86b | the focused rule-row tail `[a]gents · Esc unfocuses` *(so the focus state is never invisible, §4.3)* | same | same | `-` |

### 12.4 Import

| # | String (verbatim) | `--plain` | SR | `--ascii` |
| ---: | --- | --- | --- | --- |
| S87 | `Import your memory and workflows?  found claude-code (43 notes), codex (3 servers)` + ` 1 import now   2 later   3 never` + ` (Esc = later)` | numbered, `Enter selection (1-3):` | counts spoken as words | same |
| S88 | `setup · import — terminal too small; ≥ 40×8 to choose` | same | same | `-`, `>=` |
| S89 | `Import — 41 to import · 9 to review · 137 skipped · 38 KiB` | same | `Import: 41 to import, 9 to review, 137 skipped, 38 kibibytes` | `--`, `-` |
| S90 | the five group rows `memory 29 …` · `rules 0` · `commands 6 …` · `mcp 3   disabled on import` · `review 9   3 conflicts · 4 secrets · 2 ambiguous` | numbered | spoken | `-` |
| S91 | `[y] import all 41   [Enter] expand a group   [r] review   [Esc] later` | same | spoken | same |
| S92 | `nothing to import — no claude-code, codex or cursor configuration found` | same | same | `--` |
| S93 | `[import] applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB` | same | same | `-` |
| S94 | `[import] undo imp_… · 41 files restored · 0 modified since` | same | same | `...`, `-` |
| S95 | `[import] error: could not write <path>: EACCES (40 of 41 applied) — jevcode import --resume imp_… continues` | same | same | `--`, `...` |
| S96 | `[import] skipped <path> — <reason>` | same | same | `--` |
| S97 | *(free, from `availabilityError`, `src/tui/commands/registry.ts:600`)* `error: /import runs when the run is idle; Esc pauses first` | same | same | same |
| S98 | `memory · <n> notes · <m> rules · /memory show <n> reads one` | same | same | `-` |

### 12.5 Provider and model picker

| # | String (verbatim) | `--plain` | SR | `--ascii` |
| ---: | --- | --- | --- | --- |
| S99 | `─── models · 512 of 7 providers · by relevance ─ ↑↓ Enter Tab Esc ────` | `models (1-40 of 512) — type a number, "more", or a query, then Enter` + the one-shot prompt `pick 1-40, or type a query > ` | `models: 3 of 40 · z-ai/glm-5.3-flash · OpenRouter · $0.15/M in · Enter picks, Tab narrows, Esc closes`, coalesced ≤ 1 per 400 ms | `---`, `-`, `up/down` |
| S100 | `z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning` (from `modelSummary`, `src/models/format.ts:40`) | same | spoken | `-`, `->` |
| S101 | `live` · `cached 3 h ago` · `bundled snapshot` (from `sourceLabel`, `format.ts:67`) | same | same | same |
| S102 | `Google Gemini: no API key — set GEMINI_API_KEY` · `<Provider>: key rejected (401)` · `<Provider>: rate limited — showing the last list` · `<Provider>: offline — showing the last list` (from `errorLabel`, `format.ts:82`) | same | same | `--` |
| S103 | `7 providers · 512 models · 2 unavailable` (from `catalogueSummary`, `format.ts:101`) | same | same | `-` |
| S104 | `no model named <id> — did you mean <id1>, <id2> or <id3>? (/model to browse)` *(a **refusal** only once every configured provider's `sourceLabel` is `live` or `cached …`)* | same | same | `--` |
| S104a | `model <id> pending (next run) — not in the catalogue yet (bundled snapshot); /model browses once it loads` *(a **warning**, and the value is set: refusing a valid id offline, before the catalogue settles, or for a model newer than the snapshot is a regression on today's verbatim `pending.model = id` at `src/cli/session.ts:3071` — §6.4, §7 row 100, §14.2 #46)* | same | same | `--` |
| S105 | `no provider is configured — /login adds a key` | same | same | `--` |
| S106 | `<provider> key verified — <n> models` · `<provider> key rejected (401)` · `<provider>: rate limited — try again` | same | same | `--` |
| S107 | `<id> — browse only, generation not yet available` *(one constant, deleted in one place when D-AP lands)* | same | same | `--` |
| S108 | `provider <current> (next run: <pending>)` *(landed shape, extended to seven ids)* | same | same | same |

---

## 13. The `--plain` / `transcript.log` / `--json` pin inventory

The standing rule is `transcript.log == --plain == TUI` through one formatter or a **declared** normaliser. This
section is the round-5 half of TD4 §3.7's inventory: every producer, its sink, its twin and its declared
truncation clause. **A clause is asserted by `r5-identity.test.ts`, never skipped.**

### 13.1 Producers and their single home

| Producer | Module (owner) | Sinks | Rule |
| --- | --- | --- | --- |
| S1–S10, S43–S44 (the `/who` rows, the peer zone, the target errors) | `src/session/peers.ts` + `src/tui/status/lines.ts` (R5-1, R5-2) | Ink · `--plain` · `transcript.log` via `annotateBlock` · `sessions who --json` | the row text is built once by `whoRows`; the `--json` shape serialises `SessionActivityView`, **never** the row string |
| the `SessionActivity`/`SelfIdentity` → view **mappers** (no strings of their own) | `src/session/peers.ts` (R5-1) | feeds every row above | the **only** place `src/coordination/types.js` is read outside `src/cli/session.ts`; `activityView`/`selfView` are the sole producers of `SessionActivityView`/`SelfIdentityView`, and a property test asserts `selfView`'s output never contains `hostKey` (§7 row 61) |
| S11–S30 (pause/resume/end/claim/lock) | `src/session/picker-lines.ts` + `src/tui/commands/dispatch.ts` (R5-1, R5-2) | Ink · `--plain` · `transcript.log` · `sessions {pause,resume,end} --json` | the `--json` shape is `{ ok, runId, at, reason }`, never the sentence |
| S31–S44 (messaging, pairing, gc) | `src/cli/sessions.ts` + `src/tui/toasts.ts` (R5-1, R5-2) | Ink · `--plain` · `transcript.log` (label `[session]`) · `--json` | an applied remote verb **always** writes a `[session]` transcript item; a toast is never the only record |
| S45–S59 (context, compaction) | **`src/loop/context/meter.ts` (harness, read-only) + `src/tui/context/lines.ts` (R5-3)** | Ink · `--plain` · `transcript.log` | the four numeric strings come from the harness's own functions; the TUI adds only the glyph substitution and the empty-state sentences. **S59 is landed and must not be re-pinned** |
| S60–S86 (the agent tree) | `src/tui/agents/lines.ts` (R5-4) | Ink tab · `--plain` · SR · `jevcode agents list [--json]` | **one pure function, four render targets** (OR §4.6). `--json` serialises `AgentRow`, never the row string |
| S87–S98 (import) | `src/config/imports.ts`, re-exported by `src/tui/import/lines.ts` (R5-5) | Ink overlay · `--plain` numbered · SR numbered · `transcript.log` · `jevcode import --json` | the 17 `[import]` strings live in `config/imports.ts` **only**; `lines.ts` re-exports and never re-declares (the `credentials.ts:36,45` precedent) |
| S99–S108 (the model picker) | **`src/models/format.ts` (harness, read-only) + `src/tui/models/lines.ts` (R5-6)** | Ink picker · `--plain` numbered · SR · `jevcode models --json` | every row string is `modelSummary`/`sourceLabel`/`errorLabel`/`catalogueSummary`; the TUI owns the **layout** (which parts to drop) and the header, not the text |

### 13.2 Declared truncation and omission clauses

Seven clauses. Each is a place where the three sinks deliberately differ, each is written down here, and each is
asserted rather than skipped:

1. **`/who` column drop.** The TUI row at width *w* drops the same columns the `--plain` row at width *w* drops.
   `--plain` under a pipe (no TTY width) uses **120**. Clause: *`--plain` without a TTY renders the 120-column
   form.*
2. **The status zone is not in `transcript.log` at all.** It is a status line, not an item — the same rule the
   existing `run $`/`sess $` cells follow. Clause: *no status-zone text is ever written to `transcript.log`;
   the corresponding facts reach it through `/who`'s block or a `[session]` item.*
3. **`annotateBlock`'s row cap.** A `/who` or `/context` block issued while a run is live writes at most
   `BLOCK_LOG_MAX = 24` rows with a final `… +N more rows` (TD4 D-W, unchanged). Clause: *both the cap marker and
   the tail are asserted.*
4. **The resume card's `ctx` cell is omitted, not zeroed** when `lastPromptChars` is absent (§2.8, §7 row 38).
   Clause: *the omission is asserted in both the Ink and the `--plain` card.*
5. **`/cost`'s `held` and `free` cells are omitted, not zeroed**, until R2 lands (§8.4). Clause: *the same
   omission rule as (4); a `held $0.00` row is a bug, not a state.*
6. **The agents tab scrolls above 12 rows; it never filters.** `--plain` and `--json` print **every** row.
   Clause: *the Ink tab's visible subset is a viewport, and the `--plain` twin's row count equals
   `rows.length`.*
7. **The model picker's `--plain` twin is a numbered list of 40, not 512.** It prints
   `models (1-40 of 512) — type a number, "more", or a query, then Enter` and sets a one-shot `pendingList` with
   the prompt `pick 1-40, or type a query > ` for exactly one turn, so a stray digit can never misfire (TD4 §4.6's
   mechanism, reused not reinvented). Clause: *the count, the `more` token and the one-turn prompt are asserted.*

### 13.3 The `--json` inventory — one shape per CLI verb, and the deliberate absences

| Verb | Shape | Serialises |
| --- | --- | --- |
| `jevcode sessions who [--all] --json` | `{ sessions: SessionActivityView[], self: SelfIdentityView, at: string }` | §8.1 item 4's **two** views. The draft put coordination's raw `SelfIdentity` here, which carries `hostKey` and defeats the stated reason the view exists (§14.2 #12) |
| `jevcode agents list --json` *(needs `Command += 'agents'`, §4.2)* | `{ agents: AgentRow[], manifest: Manifest \| null }` | `src/orchestrate/index.ts`'s types |
| any `sessions <verb> <target> --json` that cannot resolve | `{ ok: false, reason: 'ambiguous' \| 'notFound', candidates?: Candidate[], message: string }` | §2.5's `TargetResult` fields, never a re-modelled shape |
| `jevcode sessions pause\|resume\|end <target> --json` | `{ ok: boolean, runId: string, at: string, reason: string }` | — |
| `jevcode sessions tell\|headsup\|request --json` | `{ ok: boolean, messageId: string, delivered: number, refused: {deviceId, detail60}[] }` | — |
| `jevcode sessions inbox --json` | `{ messages: Message[], acks: Ack[] }` | coordination's own types |
| `jevcode sessions pair\|unpair\|label\|gc\|sync --json` | `{ ok: boolean, devices: {id8, label, paired, ignored}[] }` | — |
| `jevcode sessions unlock --json` | `{ ok: boolean, reason: LockReplace['reason'], detail60?: string }` | the six-reason vocabulary of §2.10 |
| `jevcode import [--dry-run] --json` | one `ImportPlan`, no prose | `src/import/index.ts`'s type |
| `jevcode import --resume\|--undo <id> --json` | `{ importId, applied, restored, skipped, errors[] }` | — |
| `jevcode models list\|search\|refresh --json` | `{ provider, models, source, fetchedAt, stale, error }` per provider | `ListResult`/`CatalogueLoad` as-is |
| **`/context`** | **no `--json`** | there is **no** `jevcode context` verb; the machine-readable form is the `ContextUsage` object already carried by `--json=verbose`'s `status` event. Recorded here as a deliberate absence |
| **`/compact`** | **no `--json`** | same reason; the outcome is already the `context:compacted` event on **any `--json` level** — `VERBOSE_ONLY_TYPES` (`src/cli/json-stream.ts:58`) is `new Set(['status'])`, so only `status` is verbose-gated (`json-stream.ts:125`). The draft said `--json=verbose`, which is wrong for this event and right for `/context`'s (§14.2 #29) |
| **`/who` inside a session** | **no `--json`** | the CLI verb `jevcode sessions who --json` is the machine surface; a slash command inside a TUI has no JSON sink |

### 13.4 Anchors, not literals

Every string in §12 that a test greps for is a **named exported constant** in its producer module, glyph-agnostic,
with a two-glyph-set self-test — TD4 D-V's ratified pattern, extended to round 5's four new producer modules
(`src/session/peers.ts`, `src/tui/context/lines.ts`, `src/tui/agents/lines.ts`, `src/config/imports.ts`,
`src/tui/models/lines.ts`). A zero-match grep in the pin test is a **hard failure**, not a skip — the defect TD4
D-V's inventory exists to prevent (a stale pattern silently widening a measurement window).

---

## 14. The review record

The round-5 design review ran two adversarial passes — **contract-feasibility** (does every symbol, owner, wave
and gate this document names actually exist and cohere?) and **ux-edge-cases** (does every surface have a
behaviour at every fault, width and twin?) — against this worktree. **Sixty findings: 8 blockers, 29 majors,
23 minors, plus 25 named omissions.** §14.2 logs every one with its disposition. **58 applied, 2 declined**, both
declines on verified-false citations. Nothing here is new design; it is the audit trail for the edits.

### 14.1 Where the research files disagreed, and what this document takes

| # | Topic | Who disagreed | Taken | Why |
| ---: | --- | --- | --- | --- |
| 1 | **Does `llm-jev` ever show a `ctx` cell?** | **R11 §1.5** (research line 126): "on `main` today, `status.context` is populated for exactly one mode, `jev-on`", filed as a "Consequence for round 5". The §3.1 draft wrote the opposite gloss: "Only `jev-on` shows a `ctx` cell today, **and that is correct**" | **R11.** It is not correct — `DEFAULT_MODE` is `'llm-jev'` (`src/config/defaults.ts:50`), so the draft's reading shipped requirement 3 invisible out of the box | the contract's own comments read against the as-built guard (`types.ts:1345–1347`, `:1776` name only `jev-only`/`view: 'legacy'`), so the guard at `engine.ts:922` is the outlier. §8.2 **R13** files it; §1.1 states the interim scope |
| 2 | **Is `BlockingKind 'lease-conflict'` additive?** | **CD §F** (line 244) says it is **not**, and names the four spots; the D-AF/§8.2 R1/§8.4 draft called it "one additive union member" and "a one-word request" three times | **CD §F**, verified independently: `src/tui/status/lines.ts:284`, `src/tui/blocking/lines.ts:121`, `:238`, `test/unit/tui/pane/blocking.test.ts:58` | all four are exhaustive with no `default`, so `tsc --strict` breaks whether or not anything routes to the new member — §8.4's "nothing routes to it" fallback was not a fallback |
| 3 | **Where does the model picker mount?** | **R14 / D-AQ** say "a dedicated pane-slot picker mirroring `/resume`"; **§8.1 item 10 and §9.2's `layout.ts` row** made it an `OverlayKind` | **the pane-slot route** | `OverlayKind` (`src/tui/layout.ts:52`) has **no picker member at all**; `/resume` is `useReducer(pickerReducer, …)` at `App.tsx:626` rendered at `PICKER_PANE_WANT = 12` (`src/tui/Picker.tsx:163`). The two specs were incompatible, and only one of them had a precedent in the tree |
| 4 | **Does `CD §C`'s slot split or this document's §9.1 own `src/session/index.ts`?** | `CD §C` gives the `INDEX_KINDS` commit to its **R5-6**; §9.1 gives `src/session/**` to **R5-1** and D-AS said R5-6 | **R5-1** | one owner per file is the rule; R5-1 already owns every other file in `src/session/**`, and the draft contradicted itself between D-AS and §9.1 |
| 5 | **Is `instantCatalogue()` safe on the first-frame path?** | **R14 / §6.2** name it as one of two exceptions; **N7 and G-R5-1** forbid "`models/list.js`'s network path" | **neither as written** — `instantCatalogue` *is* in `models/list.ts` (`:284`), whose header statically imports `./http.js`, `./cache.js`, `./parse.js`, `./providers.js` and `../provider/sse.js` (`:16–25`) | the exception contradicted the rule. `src/models/static.ts`'s `allStaticModels()` (`:220`) has **zero imports** and returns the same rows, so it is the real exception (§6.2) |

### 14.2 Review log

Sixty findings, one row each. **Applied 58 · declined 2.** "§" cites the section this document changed.

| # | Finding | Severity | Reviewer | Section | Disposition |
| ---: | --- | --- | --- | --- | --- |
| 1 | `cycleTab`'s widened default breaks `model.test.ts:165–167`, the test the design promised stays green | blocker | contract-feasibility | §4.3, §8.1 item 10, §10 | **applied.** `PANE_TABS` stays four members; `PANE_TABS_WITH_AGENTS` is the five-member list; the default binds to `PANE_TABS`, so `:165–167` is green **and unedited**. The false "unchanged" claim is replaced with the arithmetic that disproves it |
| 2 | `App.tsx`, `Pane.tsx`, `useEngine.tsx`, `Picker.tsx`, `Console.tsx`, `StatusLine.tsx`, `Transcript.tsx` have no owner and no request row, yet all five new surfaces mount there | blocker | contract-feasibility | §9.1 (R5-4), §9.2 | **applied.** One new §9.2 row gives the six-file React shell to R5-4 as **one W3 PR** with R5-2's, R5-5's and R5-6's hunks verbatim; §9.3 (h) schedules it first in W3. `Transcript.tsx` needs no change (the `'[session]'` label routes through `formatTranscriptItem`, which branches rather than indexing a table) and is deliberately left out |
| 3 | Only the READ half of coordination is specified; nothing starts a heartbeat, mints a claim or writes a lease, so `Fold` never contains this session in production | blocker | contract-feasibility | **new §2.14**, §1.3 N8, §9.1 (R5-1), §10 | **applied.** A "what this session publishes" section: who calls `createHeartbeatWriter` (`src/coordination/index.ts:309`), on which tick, provably after `firstFrame()`; when the claim is minted and after which refusal check; that leases are written and are advisory. Not deferred to round 6 — requirement 1 is unreachable without it |
| 4 | The `ctx` cell and `/context` are empty in the product's default mode (`llm-jev`), and the design calls that state "correct" | blocker | contract-feasibility | §1.1, §3.1, §3.2, §7 row 35, §8.2 **R13**, §0 D-AG | **applied, both halves.** A numbered REQUEST gated before R5-3's W2, **and** a plain statement in §1.1 that requirement 3 is `jev-on`-only until it lands, **and** S55/S58 rewritten to name `/mode jev-on` |
| 5 | §6.3's prescribed fix puts `provider/openrouter.js` on the argv path via `models/providers.ts`, breaking §6.2, N7 and G-R5-1 | blocker | contract-feasibility | §6.3 rows 2 & 5, §8.2 **R14**, §11 G-R5-1 | **applied.** `PROVIDER_BASE_URL`/`PROVIDER_DISPLAY_NAME` move into `src/provider/ids.ts` (R14, harness-owned) with a zero-import TUI fallback; G-R5-1 now names `models/providers.js` and `provider/openrouter.js` |
| 6 | The "no total `Record<UiLabel, …>` consumer — checked" claim is false; two exist and fail `tsc` in W0 | blocker | contract-feasibility | §8.1 item 2, §9.2 | **applied.** The claim is corrected and the two files (`theme.test.ts:343`, `theme-palette.test.ts:848`) join the W0 PR with the exact two-line edit and an owner row. Noted that `contract.test.ts:64–67` still compiles (a hand-written array) but is updated for honesty |
| 7 | `jevcode agents list` is a deliverable in four places but `Command` never gains `'agents'`, and G-R5-10 is written to pass anyway | blocker | contract-feasibility | §4.2, §8.1 item 10, §9.2 (`args.ts`, `main.tsx`), §11 G-R5-10 | **applied.** Union + `COMMANDS` + usage + the `main.tsx` switch arm; G-R5-10 names all three new members literally |
| 8 | "Rows 1, 2, 3, 5, 6, 7 and 8 land as one small commit in wave 1" is impossible — five are in other slots' W4 PRs | major | contract-feasibility | §6.3 (new table), §9.3 (f) | **applied.** §6.3 now has a row-by-row owner/wave table; (f) is restated as "the consumers in W1, the cross-slot edits with their owners, all before the R9 widening". Row 8's owner corrected from R5-3 to R5-6's hunk on R5-1's file |
| 9 | Constraint (c) requires one PR across two owners' files | major | contract-feasibility | §9.3 (c), §9.2 (`session.ts`) | **applied.** R5-3 gets an explicit carve-out to land the two `src/cli/session.ts` lines itself; the alternative (same wave, hunk posted) is recorded and rejected with its reason |
| 10 | The `peers` segment contradicts TD4 §7.10 on drop priority **and** content, while §0 says "round 5 changes none of them" | major | contract-feasibility | §0 preamble, §2.2, §2.4, §12.1 | **applied.** §0 names both amended TD4 rules with the reason (unread counts outrank git state); §12.1's "kept unchanged" list moves `<n> here` to a new "superseded, not kept" list, so one segment no longer has two pinned strings |
| 11 | `SessionActivityView` is called "field-for-field a subset" but narrows `Liveness` (losing `'stale-reused-pid'`), drops `authority`, and adds ~8 derived fields | major | contract-feasibility | §8.1 item 4, §12.1 S3a | **applied.** All five `Liveness` members, `authority` restored, the doc comment rewritten to "a flattened projection of `SessionActivity` + `heartbeat`", and a per-field derivation column added as the mapper's spec |
| 12 | Two row models for one surface: `whoRows` takes `SessionActivity`, the host method and `--json` take the view | major | contract-feasibility | §2.3, §13.1, §13.3 | **applied.** `whoRows` takes `SessionActivityView[]`; the mappers live in `src/session/peers.ts` (R5-1) with their own test; `SelfIdentityView` added so `--json` stops leaking `hostKey` |
| 13 | The model picker is specified both as a pane-slot picker (§6.4) and as an `OverlayKind` (§8.1 item 10, §9.2) | major | contract-feasibility | §6.4, §8.1 item 10, §9.2, §0.2 | **applied, pane-slot route chosen.** `'models'` deleted from the overlay lists; `PickerKind`/`PickerOpen`/`pickerConsoleTitle` widened instead, with owner rows for `App.tsx`, `Picker.tsx`, `Console.tsx` |
| 14 | The first-frame import rule covers only provider/models, but `orchestrate`, `coordination` and `import` types are now held by first-frame modules, and no `import type` discipline is stated | major | contract-feasibility | §2.1 rules 3a & 6, §4.1, §6.2, §11 G-R5-1 | **applied.** The rule is stated once in §6.2 and cross-referenced; G-R5-1's list grows to nine modules |
| 15 | `/compact`'s outcome table has no branch for `context.compaction: 'off'`, the setting §3.6 itself adds — the user is told a falsehood | major | contract-feasibility | §3.3 (4th row), §7 row 42a, §12.2 S58a, §10 | **applied** |
| 16 | `/pause <target>` keeps `availableDuringTask: 'live'`, so a cross-session verb is refused from an idle TUI | major | contract-feasibility | §2.6, §4.9, §12.1 S45a/S45b | **applied.** `/pause` and `/end` move to `'any'` with hand-written per-form refusals |
| 17 | The two new `IndexLine` fields are never declared optional, and §15 Q6 assumes they are — every historical `pause` line would fail the arm | major | contract-feasibility | §2.6, §8.1 item 9, §10 | **applied.** `by?:`, `parentSessionId?:`, reader defaults `by ?? 'self'` / `parentSessionId ?? null`, and a fold test over a pre-round-5 line |
| 18 | `INDEX_KINDS` is module-private and typed `readonly string[]`, so §10's test and G-R5-10 cannot be written | major | contract-feasibility | §0 D-AS, §8.1 item 9, §10, §11 | **applied.** The D-AS commit exports it and re-types it `readonly IndexKind[]` |
| 19 | The 34 `orchestrate.*` names are never enumerated, so G-R5-8 ("every name this document mentions") is vacuous for 32 of them | major | contract-feasibility | §4.8, §8.3, §11 G-R5-8 | **applied.** All 34 enumerated from `docs/ORCHESTRATION-DESIGN.md:1427–1461`, and the gate re-worded to cite OR §6.4's table as the authority |
| 20 | §9.1 and §9.2 disagree on three owners, and one §9.2 row carries a change to a file outside its own file set | major | contract-feasibility | §9 preamble, §9.1, §9.2 | **applied.** `registry.ts` → R5-2's cell, `cli/session.ts` → R5-1's cell, `config/resolve.ts` gets its own row; §9.1 declared the single source |
| 21 | `ContextUsage` stated as 15 members in two places; it is 19, and the design's own list has 19 | minor | contract-feasibility | §0 D-AH, §3.0 | **applied** (verified: 19 fields, `src/core/types.ts:1645–1679`) |
| 22 | `engine.annotate()` cited at `types.ts:1780`, which is `retryNow`'s doc comment | minor | contract-feasibility | §3.1 | **applied** → `:1783` |
| 23 | `modeBadgeWord`'s idiom cited at `status/lines.ts:107`, an unrelated doc comment | minor | contract-feasibility | §3.1 | **applied** → `:113–114` |
| 24 | `contextSummary`/`capabilitySummary` cited at `models/index.ts:148–160`, the pricing re-export block | minor | contract-feasibility | §6.4 | **applied** → `src/models/format.ts:23`, `:30`; re-exports at `index.ts:170`, `:172` |
| 25 | `BY_NAME`'s line range off by two | minor | contract-feasibility | §5.5 | **applied**, with the **verified** range `registry.ts:557–564` — the finding proposed `:558–565`, also off by one |
| 26 | Three of the six `LockReplace` reasons carry no `detail60`, so "the same six reasons with their details" leaves three blanks | minor | contract-feasibility | §2.10, §12.1 S38a | **applied.** The sentence is corrected, the type re-cited at `records.ts:807–809`, and the three replaceable sentences pinned |
| 27 | `DROP_ORDER`'s new value stated two different ways; one omits `'peers'` | minor | contract-feasibility | §2.2, §3.1, §8.1 item 10, §9.2 | **applied.** One 7-entry array, quoted identically in four places |
| 28 | The heads-up clause drops between 120 and 80 with no stated rule, so the twin tests have nothing to assert | minor | contract-feasibility | §2.2, §2.13, §10 | **applied.** `HEADSUP_MIN_COLUMNS = 100` named, the drop order stated, the test case added |
| 29 | `/compact`'s `--json` note names the wrong level — `VERBOSE_ONLY_TYPES` is `['status']` only | minor | contract-feasibility | §13.3 | **applied** → "any `--json` level" (`src/cli/json-stream.ts:58`, `:125`) |
| 30 | D-AC's evidence misquotes TD4 §7.10's privacy contract; the stronger accurate argument was available | minor | contract-feasibility | §0 D-AC, §2.4, §15 Q19 | **applied.** The evidence is restated as "`PeerView` carries no per-peer rows"; TD4's internal `workspace`-vs-"never a path" contradiction is filed as a doc fix |
| 31 | (= #1, from the second reviewer) plus: `paneRuleRow` (`:356`) and `paneLines` (`:476`) also call `cycleTab`, and the literal strip at `:355` is a fourth hardcoded list F-54 contradicts | blocker | ux-edge-cases | §4.3, §4.11 F-54, §8.1 item 10, §12.3 S86 | **applied.** All three callers named, both literal strips (`:355`, `:377`) made computed, and F-54 corrected to the landed grammar |
| 32 | `CD §F` is never read: contract 1.5 is on `main` at `2400a0c`, four REQUESTS are stale, N1's blockers are void, and five assigned TUI to-dos are missing | blocker | ux-edge-cases | §0 (new paragraph), §1.3 N1, §8.2 R1/R2/R5/R11, §4.2, §4.5, §4.6, §2.11, §11 **G-R5-11** | **applied.** A reconciliation paragraph with the verified `merge-base` result, R2/R5/R11 re-scoped to confirmations, R1 restated, N1 re-grounded on the one remaining blocker, all five to-dos placed, and a W−1 rebase-and-re-verify gate added |
| 33 | Six files round 5 cannot ship without have no owner and no request row | blocker | ux-edge-cases | §9.1, §9.2 | **applied.** Rows for `App.tsx`, `useEngine.tsx`, `cli/main.tsx`, `keys/resolve.ts`, `glyphs.ts` and `theme.ts`, plus `Pane.tsx`, `Picker.tsx`, `Console.tsx`, `StatusLine.tsx`; the React shell is one W3 PR |
| 34 | `BlockingKind` is not additive: three exhaustive switches and one total `Record` break | blocker | ux-edge-cases | §0 D-AF, §2.11, §8.1 item 1, §8.2 R1, §8.4, §9.1, §7 row 34 | **applied.** R1 restated as five edits in one commit, `pausedWord` added to §9.2's `status/lines.ts` row, `blocking.test.ts` added to R5-2's list, §8.4's "nothing routes to it" claim deleted |
| 35 | G-R5-1 cannot pass as written: `main.tsx:31` statically imports `session.ts`, and the `instantCatalogue` exception is itself in a network module | blocker | ux-edge-cases | §2.1 rule 3a, §5.1, §6.2, §1.3 N7/N9, §11 | **applied.** The dynamic-import rule stated once; `allStaticModels()` (`src/models/static.ts:220`, zero imports) replaces `instantCatalogue()` as the first-paint source |
| 36 | `sessionRemainingUsd` has four call sites, not two; the two omitted gate money | major | ux-edge-cases | §4.10, §8.2 R2, §11 G-R5-11 | **applied.** `childCapUsd` (`:194–195`) and `followUpDecision` (`:202–203`) named; `d8490fa` cited as already-landed on `main` and confirmed **not** an ancestor of this worktree; the "entire remaining work" sentence corrected |
| 37 | S49's first form does not match `formatBudget`, so the §13.4 anchor test would fail on it | major | ux-edge-cases | §3.2, §12.2 S49 | **applied.** All five as-built forms pinned from `meter.ts:99–105`; §3.2's body block corrected; the note that a percentage would be a TUI-added row added |
| 38 | Requirement 3 is unmet at 80 columns — the only always-on usage indicator is gated at 100 | major | ux-edge-cases | §0 D-AG, §3.1, §3.7, §12.2 S45, §10 | **applied.** Two rungs, `CONTEXT_MIN_COLUMNS = 80` / `CONTEXT_FULL_COLUMNS = 100` |
| 39 | (= #16) plus: §2.7 never says what `/end` ends with no run live, so S28's `after step 7` has no referent | major | ux-edge-cases | §2.6, §2.7, §4.9, §12.1 S45b | **applied.** `/end` ends the **session** against its most recent run; with no run at all, S45b and nothing written |
| 40 | The resume card's four letters need `PickerOp` members in an unowned file, and each steals a filter letter | major | ux-edge-cases | §2.8, §7 row 91, §8.1 item 10, §9.2 | **applied.** The card becomes a focused sub-state (`PickerState.card`), six new `PickerOp` members, `resolve.ts` and `bindings.ts` given owners, the filter consequence stated |
| 41 | `KeyContext 'agents'` has nowhere to sit: no pane rung, no pane focus model | major | ux-edge-cases | §4.3, §7 row 99, §8.1 item 10, §9.2, §12.3 S86a/S86b | **applied.** `ui.paneFocus`, `Alt+A`/Esc, one rung between Picker and Composer, refused with a non-empty draft |
| 42 | The view is lossy and S1's `lanes 2 · samples 3` has no field to live in | major | ux-edge-cases | §8.1 item 4 | **applied.** `subwork` added (from `Heartbeat.subwork`, `types.ts:145`), `parentSessionId`, `arrivalAgeMs`, `branch`, `head`, `leaseCount` added, `deviceId8`'s derivation stated, `authority` restored so §2.9's `(unverified)` survives |
| 43 | Nine glyphs are used throughout §12 but `GlyphSet` has none, no slot owns `glyphs.ts`, and `◌` is given two twins | major | ux-edge-cases | §8.1 item 10, §9.2, §12.1 S3, §12.3 S60, §9.3 (g), §10 | **applied.** Nine members with twins, an owner (R5-2) and a wave (W1); the `◌`→`.` / `○`→`o` collision resolved in S60's favour and S3 corrected; an injectivity test on `asciiTwins()` added |
| 44 | (= #6) plus: `labelRole` needs a decided colour role for `'[session]'` | major | ux-edge-cases | §8.1 item 2, §9.1 | **applied.** `'dim'` (the existing fall-through) is recorded as the **decision**, `src/tui/theme.ts` given an owner. **One sub-claim corrected:** `test/unit/core/contract.test.ts:64–67` does **not** break — the array is a hand-written literal, so it still compiles; it is updated from 6 to 7 for honesty, not for the build |
| 45 | The status-line changes are internally inconsistent and miss `StatusZones['dropped']`, `SegmentId 'agents'` and the push order; F-51 and F-55 disagree | major | ux-edge-cases | §2.2, §3.1, §4.4, §8.1 item 10, §9.2, §2.12, §4.11, §10 | **applied.** One `DROP_ORDER`, `'agents'` added to `SegmentId` (and kept out of `DROP_ORDER`), `StatusZones['dropped']` widened, one push order stated and both frames corrected to it, with a list-equality test |
| 46 | Validating `/model <id>` through `findModel` is a regression with no escape hatch | major | ux-edge-cases | §6.4, §7 row 100, §12.5 S104a | **applied.** A warning (and the value is set) unless every provider's `sourceLabel` is `live`/`cached`; the list is the union of catalogue and snapshot |
| 47 | Secrets are asserted for frames and logs but not for message bodies — the one new path writing user text into a shared folder | major | ux-edge-cases | §2.9, §7 rows 92–94, §12.1 S34a | **applied.** Three rules: gated before the write with the `[y]` ladder, written through the run's redactor, redacted again on arrival before `Engine.deliver` |
| 48 | No behaviour for a stale or orphaned lease; `[w]` has no timeout, progress or escape | major | ux-edge-cases | §2.11, §7 rows 95–97, §2.13, §12.1 S39a/S39b | **applied.** Re-render on fold change with an elapsed counter and Esc; a stale holder changes the card; a `gone` holder is not a conflict at all |
| 49 | `src/tui/onboarding/lines.ts` is claimed by two slots with no shared-file row | major | ux-edge-cases | §9.1 (R5-5, R5-6), §9.2, §6.3 | **applied.** R5-5 owns it; R5-6's row-5 hunk rides R5-5's W3 PR |
| 50 | W0's stubs sit at round 4's own module paths, colliding with in-flight round-4 implementation; and `block/render.ts` is invented | major | ux-edge-cases | §8.4, §9.3 W0 | **applied.** The premise is stated (round 4 lands first, so the stub step is **deleted**); the contingency table moves to `__stub__` paths and the swap's true cost (one import line per file) is admitted; `block/render.ts` removed |
| 51 | (= #21) | minor | ux-edge-cases | §0 D-AH, §3.0 | **applied** |
| 52 | (= #30) `/peers` "changes only where the numbers come from" is inconsistent with the TD4 spec it claims to keep | minor | ux-edge-cases | §2.4, §0, §15 Q19 | **applied.** §2.4 now says which half of TD4 §7.10 survives and which is superseded by `/who` |
| 53 | `glyphSet(ascii)` is cited three times with a signature the function does not have | minor | ux-edge-cases | §2.2, §12 header, §7 row 81 | **applied** → `glyphSet({ ascii })`, with the note that `ascii` wins over `screenReader` (`src/tui/glyphs.ts:216`) |
| 54 | (= #20) three owner assignments disagree between §9.1 and §9.2 | minor | ux-edge-cases | §9 preamble, §9.1, §9.2 | **applied.** Also fixed: `status/lines.ts` was listed at two different waves (W2 and W3) — it is W3 |
| 55 | (= #18) the `INDEX_KINDS` identity test cannot be written | minor | ux-edge-cases | §8.1 item 9, §10, §11 | **applied** |
| 56 | Eight `contract 1.6 item N (TUI-DESIGN-4 …)` comments survive from round 4's draft numbering in blocks round 5 owns | minor | ux-edge-cases | §8.1 item 10, §9.2, §10 | **applied.** All eight renumbered to `contract 1.7 item N` in R5-2's W0 commit (`:1048, :1785, :1820, :1827, :1849, :1900, :1903, :1983`), with a `contract.test.ts` assertion so the collision cannot recur |
| 57 | Amber/red silently replaces the whole cell with no stated transition rule, and the once-per-run rule is undefined across a resume | minor | ux-edge-cases | §0 D-AG, §3.1, §7 row 98, §12.2 S46 | **applied.** Replaces (does not append), `/compact now` lives in the cell, and the crossing set is **per process** so a resume re-announces |
| 58 | Two contradictions in the peers zone and the `/who` head (`3 live, 1 gone` over a `stale` row) | minor | ux-edge-cases | §2.2, §2.12 F-51, §12.1 S3b | **applied.** The heads-up clause is width-gated with a named rung; F-51's head and rows share one vocabulary and the stale row moves to a new `--all` frame F-51a |
| 59 | Several `file:line` citations are off, weakening the document's opening guarantee | minor | ux-edge-cases | §2.10, §3.1, §8.4 | **partly applied, partly DECLINED.** **Applied:** `LockReplace` → `records.ts:807–809` (`:829` is `lockReplaceVerdict`); `annotate` → `types.ts:1783`; `src/tui/block/render.ts` deleted (TD4 §8 item 11 never defines it). **Declined, two sub-claims — the finding is wrong and the document was right:** `writeConfigValue` **is** at `src/config/credentials.ts:328` (grep: `328:export async function writeConfigValue`), not `:327`; and `keyEnteredText`/`savedText` **are** at `:36`/`:45` (grep confirms both), not `:35`/`:44`. The finding appears to have counted the preceding doc-comment lines. Both original citations stand unchanged |
| 60 | Three named edge cases have no row, and S1's SR twin drops two columns the visual row carries | minor | ux-edge-cases | §7 rows 12a, 22a, 95–97, §12.1 S1 | **applied.** Bench **resume** (row 12a) and pause mid-LLM-round via `PausePoint.llm` (row 22a) added; the stale-lease rows are 95–97; S1's SR twin now carries `mode jev plus llm` and `2 lanes and 3 samples` |

**The twenty-five named omissions** are each closed by the row above that shares its subject; the four with no
finding number are: the `Resolved`/`Ambiguous`/`NotFound` shapes (**now defined in §2.5** with a `Candidate` type
and a `--json` form), `SelfIdentityView` (**§8.1 item 4**), `scripts/gen-docs.mjs`'s owner (**§9.2, R5-4**), and
§14.1/§14.2 themselves (**this section**).

---

## 15. Open questions for the peer (harness) session

`CD §D`'s seven questions were answered by the peer at `CD §E`; Q1–Q7 below carry those answers forward as
**settled**, with the one residual each still leaves. Q8 onward are new.

**Carried from `CD §D`/`§E` — settled, with residuals:**

1. **The `Ledger` type.** *Answered:* the TUI imports `LedgerHandle`, the return type of `openLedger()`; a W2b
   wave most likely exports `Ledger` as an alias of it. **Residual:** round 5 types against `LedgerHandle` today
   (D-AD) — please confirm the alias will be a *rename with no shape change*, so the swap is find-and-replace and
   not a narrowing.
2. **`StageName 'coordinate'` / `StepRecord.coord`.** *Answered:* W2b engine wiring, expected before round-5
   implementation. **Residual:** round 5 deliberately builds **no** surface on `StepRecord.coord` (§8.2 R10) and
   reads the fold instead. If W2b lands early, does the peer want an advisory heads-up UI in round 5 after all, or
   is round 6 the right home?
3. **`IMPORT-DESIGN.md` and `COORDINATION-DESIGN.md` as-built passes.** *Answered:* import's W4 wave includes a §7
   as-built table. **Residual (new, and small):** CO §8.6's pinned compaction string
   (`compaction: 41k → 12k chars (code)`) does not match the engine's own line at `src/loop/engine.ts:3567`, and
   the design's claim that `context:compacted` "is a transcript item" is contradicted by the engine's comment at
   `:3560–3562`. Round 5 keeps the as-built line (D-AJ) — **please correct those two sentences in
   `COORDINATION-DESIGN.md` §8.6** rather than changing the string.
4. **Secret question ids.** *Answered:* the ordinal `secret_<i>` plus the `secretCandidateId → ordinal` table is
   the contract now; import W4 may content-key group I. **Residual:** round 5's fixtures hard-code `secret_0`,
   `secret_1`. If W4 does content-key it, please flag the wave so the fixtures move in the same PR.
5. **Contract numbers.** *Answered:* round 5 takes **1.8**, Fastlane 1.9, header order ascending after 1.4.
   **Residual:** this worktree's `docs/DECISIONS.md:1034–1042` still stops at 1.7; the one-line sync happens at
   merge. Confirm nobody else is editing that paragraph in the same window.
6. **`INDEX_KINDS` names.** *Answered:* final as designed, all seven landed in one commit by the TUI session.
   **Residual:** round 5 also adds `by` to the existing `pause` arm and `parentSessionId` to `run:start` (§8.1
   item 9). **Both are now declared optional** (`by?:`, `parentSessionId?:`) with stated reader defaults
   (`by ?? 'self'`, `parentSessionId ?? null`) — an earlier draft declared them required while this question
   assumed optional, which would have failed every historical `pause` line's arm shape. The harness's
   `seedMeterFromIndex` reads the same file: confirm no harness reader breaks on two new **optional** fields.
7. **`meter.heldUsd()`.** *Answered:* lands with the engine wave, with `hold(agentId, usd)`/`release(agentId)` and
   `SpendSnapshot.heldUsd` restored by `restore()`. **Residual:** until then `/cost` **omits** the `held` and
   `free` cells rather than printing `$0.00` (§13.2 clause 5). Confirm that is what the peer expects to see in the
   interim, since OR §6.7's pinned `/cost` line shows both.

**New questions:**

8. **`BlockingKind 'lease-conflict'` (§8.2 R1).** `BlockingAnswer` (`src/core/types.ts:1226`) already carries
   `'wait'` and `'worktree'` with a comment naming this exact pane, and `PausePointReason` (`:1548`) already has
   `'worktree'` — but `BlockingKind` (`:1225`) has no member. Can the harness land the one word in wave 0? If not,
   round 5 ships §2 without the pane and nothing else changes (D-AF's fallback) — but we would like the answer
   **before** wave 1, not during it.
9. **`ProviderName` / `GeneratorConfig.provider` — confirmation, not a request (§8.2 R9, D-AP).**
   `src/provider/registry.ts:16` already reads "(src/core/types.ts is owned by the TUI/session round)" and says
   widening those two unions to `ProviderId` "makes `createProvider()` return exactly a core `Provider` with no
   other change here", so round 5 takes the widening as its own contract-1.8 item 6. **Please confirm no in-flight
   harness change touches `types.ts:649` or `:2005` in the same window**, and that
   `src/config/validate.ts:161`'s `one of anthropic|openrouter` check has no harness-side caller that depends on
   the narrow union.
10. **`orchestrate.maxAgents` default 3.** Is 3 deliberate conservatism against the per-process cost multiplier
    (OR §6.6's "~15× chat tokens… ~7× for agent teams"), or a placeholder pending OR's M10 measurement? Cursor 3
    caps at 8. We would rather ship a default with a stated reason than a number.
11. **`jevcode agents list --json`'s row schema.** OR names `AgentRow` as "the one row model every surface
    renders", but the `--json` output is not shown verbatim anywhere. **Is `AgentRow` field-for-field the JSON
    shape, or does a `--json` consumer get `LandAttempt` history inline?** Round 5 assumes field-for-field
    (§13.3).
12. **`EndOptions.by`.** `PauseOptions.by` accepts `peer:<sid>`/`device:<id>` (`types.ts:1576`), but
    `EndOptions.by` is `'human' | 'remote'` (`:1593`). Is `end` deliberately narrower than `pause` — because
    ending is more consequential — or is the asymmetry an oversight? Round 5 renders `remote` as
    `ended by a peer` and does not name which one; if the widening is wanted, §2.7's string gains the label.
13. **`renderReport`/`renderPlanJson`'s exact-redaction gap (§8.2 R7).** `src/import/report.ts:273`, `:295` call
    `redactSecrets(text)` with no second argument, so `report.md` and `plan.json` get the 15 pattern families but
    not the caller's configured-secret layer that `discover.ts` and `index.ts:331` do thread through. **Accept and
    document, or thread the parameter?** `docs/IMPORT.md` cannot state a true redaction guarantee until this is
    answered.
14. **`FORMAT_PATTERNS` for xAI, Fireworks and Meta (§8.2 R8).** `src/core/redact.ts:68–75` has no family for
    those three key shapes, so a pasted-but-unsaved key of those shapes is uncaught by the pattern layer. Is
    adding them already planned, and does the harness want live-verified prefixes before landing them?
15. **`formatMeter`'s glyph parameter (§8.2 R4).** Would the harness rather take an optional `g: GlyphSet` on the
    three `src/loop/context/meter.ts` formatters (mirroring `modeBadgeWord`'s signature), or have the TUI keep
    post-processing the output for `--ascii`? Both work; the former is the smaller footgun for the next edit to
    those strings.
16. **A `context:warn` event.** Round 5 computes the 85 %/95 % crossing client-side (D-AG) because no event
    exists. Would a `context:warn` member — symmetrical with `budget:warn` — be welcome later, so
    `--json=verbose` consumers see the crossing without polling `pct`?
17. **`Heartbeat.context`'s stale field.** `src/coordination/types.ts:151` and the zero-value builder in
    `src/coordination/heartbeat.ts:74` still spell `windowBudget`, a name CO §14 item 16(d) records as removed
    from the contract in favour of `budgetTokens` + `windowTokens`. Nothing imports `coordination/heartbeat` today,
    so it is inert — rename now while it is free, or when the `'coordinate'` stage is wired?

19. **`docs/TUI-DESIGN-4.md` §7.10 contradicts itself, and round 5 amends it (doc fix, not a code change).**
    TD4 §7.10 item (2) specifies "one kv row per peer — `workspace`, `started <t> ago`, `<state>` — **never a pid
    and never a path**" (`docs/TUI-DESIGN-4.md:2816–2817`), and `workspace` **is** a path. Separately,
    `PeerView` (`src/core/types.ts:1904–1909`) is four scalars and cannot carry a per-peer row at all, so the
    clause is unimplementable against the type TD4's own §8 item 9 defines for it. Round 5 keeps TD4's head,
    empty state, stub state and blocking row verbatim and **supersedes the per-peer rows with `/who`** (§2.4),
    and amends TD4 §7.10 edge (2)'s "first thing dropped" because the round-5 segment carries unread-message
    counts (§2.2). **Please confirm the TD4 doc fix rather than reinstating the rows.** This is a question for the
    TUI owner, since TD4 is this session's own document.
20. **`Heartbeat.subwork`'s shape.** `SessionActivityView.subwork` (§8.1 item 4) is the only source for S1's
    `lanes 2 · samples 3`, projected from `Heartbeat.subwork: SubworkEntry[]` (`src/coordination/types.ts:145`).
    Round 5 folds it to `{ lanes, samples, probes, children }` by counting `SubworkEntry.kind`
    (`'sample' | 'lane' | 'probe' | 'child'`, `:81`). **Is a count per kind the intended reading**, or does a
    consumer need the entries themselves? The heartbeat's own degrade path (`:168`) drops `subwork` before
    `touchedRecent`, so the row must render with `subwork: null` — confirm that is the intended precedence.
21. **The heartbeat writer's tick versus the idle-frame gate (§2.14, gate G-R5-3).** `createHeartbeatWriter`
    (`src/coordination/index.ts:309`) carries its own `HEARTBEAT_COALESCE_MS`. Round 5 adds no timer of its own
    (the `setInterval( only in spinner.ts/retry.ts` rule holds) and asserts that **two live peers beating every
    2 s do not raise the idle frame rate at all** — the zone re-renders on fold change, not on a timer. **Does the
    writer's own tick wake the fold watcher on the writing side too?** If it does, a single idle session beating
    to itself would cost frames, and the coalescing window becomes a TUI-visible number.

### 15.1 Peer answers (harness session, 2026-09-22, "from the landed code") — binding for every slot

| Q | Answer | Consequence for round 5 |
| --- | --- | --- |
| 1 | `Ledger` becomes an alias of `LedgerHandle` — a rename with no shape change (W2b wave) | type against `LedgerHandle` now; the swap is find-and-replace (D-AD) |
| 2 | `StageName 'coordinate'` and `StepRecord.coord` land with W2b **before** round-5 implementation starts; names arrive with its hash | still no surface on `StepRecord.coord` in round 5 (§8.2 R10); the fold is the source |
| 3 | COORDINATION-DESIGN §8.6 is being corrected to the as-built wording: the typed `context:compacted { step, chars: {before, after}, by }` event is emitted beside a `notice{kind:'ui', label:'[ui]'}` line whose text is `compaction: <before> → <after> prompt chars (code); <folded> at step <n> (<why>)` with the event JSON in `detail`; `itemsFromEvent` has **no** case for the typed event (no duplicate line); engine.ts:4356 | D-AJ (b) confirmed; §3's compaction row cites the `[ui]` notice line, not the typed event |
| 6 | the engine adds nothing to the session index; `src/session/index.ts:181`'s parser checks version/time/kind and reads named fields per case, so extra **optional** members are ignored by construction; `seedMeterFromIndex` reads amounts only | `by?` on `pause` and `parentSessionId?` on `run:start` are safe (D-AS); R5-1 adds the parser test that proves it |
| 7 | **`meter.heldUsd()` and `snapshot().heldUsd` are ON MAIN already** (`src/spend/meter.ts`, since 2400a0c) | **supersedes §13.2 clause 5**: `/cost` shows `held` and `free` from the first commit, never an interim omission; the two `sessionRemainingUsd(...)` call sites in `src/cli/session.ts` pass `sessionMeter.heldUsd()` (landed before round 5 — see §0.3 item 6's list once committed) |
| 9 | confirmed: no in-flight harness change to `ProviderName` / `GeneratorConfig.provider` (types.ts:649/:2005) and no harness caller of validate.ts:161's two-name check | D-AP (a) proceeds as contract 1.8 item 6. **Sequencing:** once the widening lands, the harness wires the five adapters as generators (`createProvider()` from `src/provider/registry.ts` behind `GeneratorConfig.provider`) *right after*; until that harness commit, selecting one of the five saves the choice and the next run refuses with §12's "provider <id> is not wired for generation in this build" string — the picker never claims a run will work before it can |
| 10 | `orchestrate.maxAgents` default 3 is deliberate (OR §6.4) | the config row's help text states the reason (the per-process cost multiplier), not just the number |
| 11 | `jevcode agents list --json` is `AgentRow` field for field | §13.3 stands |
| 12 | intended: `RunEnded.by` is who ended the run (`human` \| `remote`); the peer/device label rides the pause point's `by` | §2.7 renders `ended by a peer` and, when the pause point's `by` names one, appends its label from that field |
| 13 | accepted — a fix is running: the report and plan.json renderers take the exact layer | §8.2 R7 closes when its hash arrives; `docs/IMPORT.md` may then state the full redaction guarantee |
| 14 | xAI (`xai-…`) and Fireworks (`fw_…`) join the redacting families (15 → 17), running now; **no Meta pattern** until its key shape is documented | §6's key-setup flow for Meta relies on the exact layer only and says so in its row; R8 partly closes |
| 15 | the three `meter.ts` formatters stay plain; the TUI post-processes with the `asciiTwins` map | §12/§13 pin the `--ascii` twins of `formatMeter`/`formatMemory` output in the TUI, as the design already does |
| 16 | **new event, additive, running now:** `{ type: 'context:warn'; step; pct; budgetTokens; tokensInWindow }`, emitted once per upward crossing of the 85 % line, relaxed view only, re-armed after a compaction; no `itemsFromEvent` case | **amends D-AG:** the amber word and the one-time `annotate()` notice fire on `context:warn` when the event exists; the client-side per-process crossing set remains for the 95 % rung and for resume (the event is not replayed) — never two notices for one crossing |
| 17 | `Heartbeat.context` renames to `budgetTokens` + `windowTokens` in the W2b wave | round 5 reads the new names; nothing reads `windowBudget` |
| 20 | intended: counts per `SubworkEntry.kind`; `subwork: null` after the degrade path means "truncated away", not "none" | §2.5's row renders `lanes ? · samples ?` (the §12 `?` twin) for null, and `lanes 0 · samples 0` only for an empty array |
| 21 | the writer does not call the fold; its own write lands in the local subtree, `fs.watch` fires, the fold refreshes within the 100 ms debounce and labels the record `self` by read location; W2b's report states it precisely | gate G-R5-3 stands: idle frames do not rise with peers beating; the self-write refresh is a fold change, not a timer |

### 15.2 W2b landed on main at `7efac12` (harness session, 2026-09-22) — the names round 5 binds to, binding; supersedes §15.1 rows 1, 2 and 17 where they differ

- **`StageName 'coordinate'`** — loop order **between `risk` and `execute`**; the four TUI stage tables gain the word and the guard's `PENDING_TUI_STAGES = ['coordinate']` is deleted in that commit (landed before round 5 — see §0.3 item 6 once committed). `StepTiming.coordinateMs? / coordWaitMs?`.
- **`StepRecord.coord: StepCoord { conflicts[], requested?[], decision?: 'proceed' | 'continue' | 'wait' | 'worktree' | 'blind', waitedMs? }`** — §8.2 R10 stands (no surface on it in round 5 beyond `/why`'s block through the stage tables); the fold is the activity view's source.
- **Events:** `coordination:facts { step, coord }`; `coordination:decision { step, decision, by: 'fence' | 'human' | 'default', waitedMs, paths }`; `session:message { message: DeliverableMessage, disposition: MessageDisposition { action, downgraded, needsConfirm, refused, authority }, applied: AckOutcome | null }`. The engine applies only `needsConfirm === false` messages and acks them itself; the gated ones are the TUI's `[y]` confirm, and the TUI acks `applied | refused` through **`CoordinationRuntime.ack(msgId, outcome, detail60)`** (detail ≤ 60 cells).
- **`NoticeKind += 'coordination' | 'session'`**; **`EngineRunPhase`**; **`EngineStatus.{ phase?, subwork?, coordination?: CoordinationStatus { peers: [{ runId, sessionId, deviceId, label, step, stage, phase, beatAgeMs, sameDevice, blocked, live, cloned }], live, conflicts, inbox, mirror: { state, code, lagMs } | null, off, waiting: { paths, holder, untilMs } | null } }`** — all three **absent** with no ledger (render nothing, never `0 peers`).
- **`EngineOptions.coordination: CoordinationOptions { ledger: LedgerHandle | null, enabled?, claims?: 'advisory' | 'strict' | 'off', strictWaitMs?, default?: 'proceed' | 'wait', remoteControl?: 'allow' | 'confirm' | 'never', syncRuns?, peerLive?, identity? }`** — the design's `leases` field is **`claims`** (§12.0.1 spelling); every `leases` in this document reads `claims`.
- **The consumer type stays `LedgerHandle` — there is NO `Ledger` alias** (reverses §15.1 row 1). D-AD (b) is unchanged: `LedgerHandle` everywhere, permanently.
- **Own heartbeat in the fold:** our own beat is in `ledger.fold` synchronously via `adoptOwn` (labelled `self` by write location) before any watcher fires, but `adoptOwn` does **not** `emit()` — a push-only view lags its own row by the 100 ms debounce (up to 15 s with no `fs.watch`). **Rule:** the activity view reads `ledger.fold` on mount and after every own write, then subscribes; §2.14 and gate G-R5-3 are amended accordingly (the mount read is not a timer).
- **`BlockingKind`** `'land-preflight'` and `'lease-conflict'` are in main's history at `c7087e2` with placeholder case lines; round 4's owner pass restyles them (`land pre-flight`, `lease conflict`; keys `[c] [s] [x]` and `[w] [c] [t] [q]`; `pausedWord` → `paused: land pre-flight` / `paused: lease conflict`), so round 5 finds the real members and the styled labels already on main (D-AF).

**One question for the owner, not the peer:**

18. **`/model`'s save-as-default key.** Claude Code's picker forks Enter (save as the user's default) from `s`
    (this session only). JevCode's `/model` has a third, narrower semantics — "pending for the **next run** only"
    — which round 5 keeps unchanged (§6.4). `s` is reserved and unbound. **Is a save-as-default key wanted in
    round 5, or is "next run only" the intended permanent behaviour with `jevcode config set generator.model` as
    the way to persist?**
