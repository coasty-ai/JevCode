# Round-5 topic: the context meter and compaction UI

Repo: `/Users/prateekjannu/Documents/vscode/JevCode`, worktree `r5-design`, branch `r5-design`. Read-only research;
only this file was written. Every symbol below was read directly from the files in this worktree (not copied from
the digest or the design docs) — line numbers are as-seen 2026-09-22. This topic sits in slot **R5-3** of
`00-contract-digest.md` §C, sharing `src/tui/status/lines.ts` with R5-2 and `src/tui/commands/registry.ts` with R5-1.

---

## 1. What the designs and code say (verified, file:line)

### 1.1 The contract is already fully built — further than the digest credits

`docs/COORDINATION-DESIGN.md` §12.0.3 and the digest's row 33/34 (`00-contract-digest.md` line 33-34) describe
`EngineStatus.context?` and `Engine.compact?()` as landed types with the *rendering* work still to do. That's true,
but the digest undercounts how much of §8's **engine-side machinery** is also already built and wired, not just
declared:

- `EngineStatus.context?: ContextUsage` — `src/core/types.ts:1454-1455` (comment + field), guarded exactly as the
  digest says: optional, no default.
- `ContextUsage` (`src/core/types.ts:1645-1679`) has **15 members**, not the 7 the digest's row 33 lists
  (`tokensInWindow, budgetTokens, windowTokens, compactions, lastCompactionAt, compaction`). The as-built interface
  also carries `budgetBoundBy: 'window'|'money'|'floor'|'ceiling'`, `usdPerStep: number|null`,
  `windowTooSmall: boolean`, `recentSteps: RecentStepsUsage`, `promptBuildMs: number`, `refreshMs: number` — all of
  which `/context`'s detail block needs and none of which the digest names. `RecentStepsUsage`
  (`types.ts:1682-1689`) is `{ chars, allowanceChars, whole, clipped, oneLine, reads }`.
- `Engine.compact?(): void` — `src/core/types.ts:1779`, exactly as the digest cites. But the **implementation is
  not a stub**: `src/loop/engine.ts:1519-1523` is a real body (`if (!this.contextEnabled || this.isFinished() ||
  this.contextPolicy.compaction === 'off') return; if (foldableCount(this.history) === 0) return;
  this.compactContext(this.step, 'manual'); this.emitStatus();`), and the automatic triggers
  (`src/loop/engine.ts:3531`, `compactionDue`) already fire every `compactEvery` steps, at 85% of budget, and on a
  resume that folded past the history window (`compactionDue` in `src/loop/context/compaction.ts`, imported at
  `engine.ts:119`). `src/loop/context/**` is six files, 1,339 lines (`compaction.ts`, `context-cache.ts`,
  `history.ts`, `limits.ts`, `meter.ts`, `types.ts`) — this is a finished subsystem, not a design sketch.
- The pinned status text is **already a real function**, not just design prose:
  `formatMeter(u): string { … return \`ctx ${u.pct}% · ${u.files} file${…} · ${u.historyEntries} step${…}\`; }`
  — `src/loop/context/meter.ts:108-112` — produces exactly `ctx 41% · 6 files · 12 steps`, byte for byte, before
  round 5 writes a line of TUI code.
- `--json=verbose` already carries the whole `ContextUsage` object with **zero new work**: `status` events ride
  the NDJSON stream only under `--json=verbose` (`src/cli/args.ts:138-139,463-474`; `src/cli/json-stream.ts:57-64`),
  and `status` is `EngineStatus`, which already has `context?`. §8.7's "`--json=verbose` carries the object" is
  done today.

### 1.2 What is genuinely missing: the render path, not the engine

None of this is rendered anywhere yet:

- `src/tui/status/lines.ts` (703 lines) has **no `ctx` segment at all** — `grep -n "ctx\b" ` matches nothing except
  the unrelated `StageName` string `'context'` inside `STEP_WORDS` (`:159`). The right-zone segment machinery is a
  closed union today: `type SegmentId = 'step' | 'run' | 'sess' | 'tokens' | 'git' | 'spark' | 'help' | 'secret'`
  (`:401`), assembled by `rightZoneSegments` (`:450-479`) and dropped by `DROP_ORDER: readonly ('help'|'spark'|
  'git'|'sess'|'wall')[] = ['help', 'spark', 'git', 'sess', 'wall']` (`:412`). `StatusLineState.status: EngineStatus
  | null` (`:66`) is already the right shape to read `s.status?.context` from — the guard the digest and the design
  both call for is a one-line `if (s.status?.context !== undefined)` away, not a new field.
- `src/tui/commands/registry.ts`'s 37 rows have no `context` or `compact` command (confirmed, matching the digest).
- `src/cli/session.ts`'s `resumeRun` (`:2296-2360+`) builds no §7.3-style card at all yet — `ctx`/`lastPromptChars`
  do not appear anywhere in the file. This is pre-round-4 `main`; the whole card is round-4/5 work.
- No `─ compaction ─` separator, no `itemsFromEvent` case for `context:compacted`, exists anywhere under
  `src/tui/**` (`grep -rn "context:compacted" src/tui` is empty). See §1.4 below for what actually happens today.

### 1.3 A real gap the digest missed: `context.*` has no config path at all, not even a hook

The digest's IMPORT-DESIGN row (`00-contract-digest.md` line 101) flags "zero rows in `src/config/{defaults,
resolve,types}.ts`'s `SETTINGS` schema" for `context.compaction`. Reading the code shows the gap is **one layer
deeper** than a missing schema row:

- `SettingName` (`src/config/types.ts:6-63`) has zero `context.*` members. Confirmed by direct read of every one of
  the 57 rows — the only round-4 additions present are `ui.renderer` / `ui.fullscreenDump` (`:35-36`, contract 1.6).
- `ResolvedConfig` (`src/core/types.ts:2038`) declares an optional hook for exactly this purpose —
  `context?(): ContextPolicyOptions` at `types.ts:2076`, whose own doc comment (`:2071-2075`) says *"Optional so no
  existing `ResolvedConfig` fake breaks; `config/resolve.ts` **always** sets it."* That claim is false today:
  `grep -n "context(\|ContextPolicyOptions" src/config/resolve.ts` returns **nothing**. The object literal
  `resolveConfig` returns (`src/config/resolve.ts:435` down to the `ui`/`sessionSpendCap`/`addSecret` members around
  `:697-707`) has no `context:` property. `ContextPolicyOptions` is used in exactly one other place in the whole
  repo outside `core/types.ts` and `src/loop/context/**`: `test/unit/loop/fakes.ts:716`, a test fake that builds
  `EngineOptions.contextPolicy` directly, bypassing config entirely.
- `EngineOptions.contextPolicy?: ContextPolicyOptions` (`types.ts:1248`) is never referenced in `src/cli/session.ts`
  at all (`grep -n contextPolicy src/cli/session.ts` — nothing). So today, **no CLI flag, no config file key, no
  environment variable, and no code path reaches `EngineOptions.contextPolicy`** in a real run; `resolveContextPolicy`
  (`src/loop/context/limits.ts:127-141`) always runs with `p === undefined`, i.e. always its own defaults
  (`view: 'relaxed'`, `compaction: 'code'`, `compactEvery: 8`, `budgetChars` derived purely from
  `generatorPricing.contextTokens`/`limits.spendCapUsd`/`limits.maxSteps`).

So round 5 is not just adding one `context.compaction` settings row — it is building the **entire chain**: schema
row → `ResolvedConfig.context()` implementation in `src/config/resolve.ts` (a new small resolver, mirroring
`resolveUiConfig`'s pattern at `src/config/ui.ts:55-75`) → a `contextPolicy: rcfg.context?.()` line at each
`createEngine`/`defaultEngineFactory` call site in `src/cli/session.ts`.

### 1.4 Compaction's transcript notice already exists, and its wording differs from the design's pin

`context:compacted` (`src/core/types.ts:1525`) is a typed event, emitted for real at `src/loop/engine.ts:3559`. Per
its own doc comment (`engine.ts:3536-3540` and `core/types.ts:1777`), **it yields no transcript item of its own** —
`itemsFromEvent`/`src/tui/plain.ts` has no `case` for it, confirmed by grep. What the user actually sees today is a
sibling `notice` event, kind `ui`, label `[ui]` (`engine.ts:3567`):

```
compaction: <before> → <after> prompt chars (code); <N> steps folded into the summary at step <S> (<why>)
```

— e.g. `compaction: 41230 → 12840 prompt chars (code); 4 steps folded into the summary at step 8 (every 8 steps)`.
This **diverges from `docs/COORDINATION-DESIGN.md` §8.6's own pinned line** (`compaction: 41k → 12k chars (code)`)
in three ways: no `k`-abbreviation (raw char counts), extra clauses (`prompt chars` not `chars`, the fold count and
step and trigger reason appended), and the design's claim that it is "classified as a transcript item" is
contradicted by the engine's own comment ("no transcript item of its own"). Because the notice carries `e.label`
(`'[ui]'`), `itemsFromEvent`'s existing generic `case 'notice'` (`plain.ts:353-358`) renders `e.text` verbatim with
no `notice ui:` prefix — so the line above is what lands in `--plain`, `transcript.log` and the TUI's own
`<Static>` scrollback today, once round 5 does nothing at all. Round 5's job is deciding whether to keep this
wording (recommended — see §5) or to change the harness's own string to match the design's `k`-abbreviated pin
(a cross-slot request, since `engine.ts` compaction is `src/loop/**`, harness-owned per the repo rules banner).

### 1.5 The context meter is populated in exactly one engine mode on `main` today

`EngineMode = 'jev-on' | 'jev-off' | 'jev-only' | 'llm-jev'` (`src/core/types.ts:482`). Inside the full `Engine`
class, `this.contextEnabled = this.contextPolicy.view === 'relaxed' && (this.mode === 'jev-on' || this.mode ===
'jev-off')` (`engine.ts:922`). But `src/cli/session.ts:776-778`'s `defaultEngineFactory` routes `mode === 'jev-off'`
to a **completely different class**, `createGeneratorOnlyEngine` (`src/loop/generator-only.ts`), which has no
`compact` method and no context bookkeeping at all (`grep -n "compact\|context" src/loop/generator-only.ts` matches
only an unrelated doc comment). So in the real CLI path, `jev-off` never reaches the `contextEnabled` branch above —
it is only reachable when a unit test constructs the `Engine` class directly with `mode:'jev-off'`
(`test/unit/loop/engine-context.test.ts:247-259` does exactly this). `jev-only` and `llm-jev` both go through the
full `Engine` class but are **explicitly excluded** by the `||` — the doc comment right above says why: "under
`view: 'legacy'`, and in the modes that never read it, none of §8 exists" (`engine.ts:923`). `llm-jev` has its own,
separate relaxed-context mechanism (`SynthesisContext.contextText?`, described in §8.8's table) that never touches
`EngineStatus.context` at all.

**Consequence for round 5:** on `main` today, `status.context` is populated for exactly one mode, `jev-on`. The
`ctx N%` status cell and `/context`'s detail block will be silently absent (by the existing, intentional guard) for
`jev-off`, `jev-only` and `llm-jev` runs — three of four modes — and `llm-jev` will *never* show it even after the
per-goal sample-context work lands, because that context lives in a different object entirely. `/context` needs an
explicit sentence for this case (§3, §4), not just "before the first prompt."

### 1.6 `/context`'s detailed body needs data `EngineStatus.context` does not carry — but `Engine` already has it

§8.7's `/context` lists every section with chars, and *why* each file is in view
(`read at step 4 · edited step 6 · pinned by you`). `ContextUsage.files` is a **count** (`types.ts:1649`), not a
list — `EngineStatus.context` cannot answer "why is this file in view." The per-file reasons live on two other
state fields: `FileCacheEntry { rel, pinnedBy: FilePin, lastUsedStep, bytesShown }` (`types.ts:1706-1712`,
`FilePin = 'read'|'edit'|'human'|'jev'|'seed'` at `:1703`) and `FileMemoryEntry { sha12, bytes, readAt, editedAt }`
(`types.ts:1715-1721`) — `/context`'s "read at step 4 · edited step 6" line needs `readAt`/`editedAt` from
`fileMemory`, joined by path to `fileCache`'s `pinnedBy`. Neither is on `EngineStatus`. They **are** reachable
through `Engine.snapshotState(): CheckpointState | null` (`types.ts:1758`; implemented at `engine.ts:1062-1068` as
`this.buildCheckpointState()`, wrapped in a `try`/`catch` fallback to the last snapshot) — its private helper
`contextExtension()` (`engine.ts:3315-3324`) spreads `history`, `fileCache`, `fileMemory`, `summaryAt`,
`compactions`, `lastCompactionAt` onto the returned `CheckpointState` whenever any is non-empty. `snapshotState()`
is already used for the last-resort checkpoint write (§11); nothing stops `/context` from also calling it — it is
synchronous, in-memory, and safe on a live run.

**What `snapshotState()` does *not* carry: the rolling summary's text.** `CheckpointState.summaryAt?: number | null`
(`types.ts:991`) is only the step index. The actual `ContextSummary` object (`Objective`/`Completed`/`Active`/
`Blocked`/`Files`/`Tests`/`Notes`, `src/loop/context/types.ts:13-21`) lives in the engine's private `this.summary`
field and is persisted separately to `<runDir>/context/summary.json` (`engine.ts:3558`, via
`CheckpointStore.writeContextSummary`, `src/checkpoint/store.ts:225,856-864`, atomic — `writeFileAtomic`). On
resume, the engine lazily re-reads that same file the first time it needs it (`engine.ts:3341-3343`:
`if (!hasContextStore(this.store) || this.summaryAt === null || this.summary !== null) return; … this.summary =
raw;`). There is **no public `Engine` method that returns the summary text** for a live run. `/context`'s "Summary"
section therefore needs one more read: `store.readContextSummary()` on the *same* `CheckpointStore` instance
(`hasContextStore`, `src/checkpoint/types.ts:35-42`, already exported) that the resumed-run path already builds via
`createCheckpointStore(dir, redact)` (the exact call `src/cli/session.ts` makes today at its `loadRun`/`resumeRun`
call sites). Since the TUI and the engine share one process, this file read carries no cross-process race — the
write side is already atomic — but it is a small missing piece nobody has named yet: **either read
`context/summary.json` directly with the store's own reader, or (cleaner, but a cross-slot ask) add a small
additive `Engine` accessor for the live summary text.** See §5.

### 1.7 `/context drop <file>` and `/keep <text>` need engine methods that do not exist yet

§8.7 names `/context drop <file>` and §8.6 names `/keep <text>` as commands. `grep -n "dropFile\|drop(\|keep("
src/core/types.ts` on the `Engine` interface finds nothing matching either verb. Both are **writes** to the live
engine's file cache / kept-items list, and neither has a contract member today (unlike `/compact`, which already
has `Engine.compact?()`). Round 5 should scope these out of the MVP or file them as a second, harness-owned contract
addition — see §5, §6.

### 1.8 A stale field name in the coordination mirror, unrelated to round 5 but worth flagging once seen

`docs/COORDINATION-DESIGN.md` §14 item 16(d) records that `ContextUsage` was **reversed** to `budgetTokens` +
`windowTokens`, with `windowBudget` explicitly "gone from the contract" (confirmed: `core/types.ts`'s `ContextUsage`
has no `windowBudget` member anywhere). But `Heartbeat.context` (`src/coordination/types.ts:151`) and its zero-value
builder (`src/coordination/heartbeat.ts:74`: `context: { pct: 0, files: 0, historyEntries: 0, summaryAt: null,
tokensInWindow: 0, windowBudget: 0, compactions: 0 }`) still spell the pre-reversal name. This is currently inert —
`grep -rln "coordination/heartbeat"` under `src/` finds **zero import sites**, confirming the digest's own note that
the `'coordinate'` micro-stage is not wired into `engine.ts` yet, so no real heartbeat ever carries live numbers here.
But whoever wires that stage will either need to rename this field or add `budgetTokens`/`windowTokens` beside it —
worth a line in the peer's own contract-digest follow-up, not just this file (§6).

---

## 2. What the best tools do (cited)

- **Claude Code.** `/context [all]` — *"Visualize current context usage as a colored grid"* (`docs:commands`,
  cited in `docs/research/tui/02-claude-code.md:403`). The live docs page for `/context`
  (`https://code.claude.com/docs/en/context-window.md`, fetched 2026-09-22) frames it as *"a live breakdown by
  category with optimization suggestions, including which CLAUDE.md and auto memory files loaded."* `/compact
  [instructions]` — *"Free up context by summarizing the conversation so far"*, and *"in a fresh session prints
  `Not enough messages to compact.`"* (`docs:costs`, `02-claude-code.md:400`). The same page's walkthrough gives the
  exact terminal notice: a **"Conversation compacted" message**, then a one-line `Read <file>` per re-read file
  (capped at five, most-recently-modified first; a file over 5,000 tokens comes back as `Referenced file` instead
  of `Read`) and a line naming which invoked skills were restored. `/autocompact [auto|<tokens>]` sets *"how full the
  context window gets before Claude Code compacts automatically"* (`02-claude-code.md:401`); the actual threshold is
  model-dependent (`docs/en/model-config#default-auto-compact-thresholds`). Rules with `paths:` frontmatter and
  nested CLAUDE.md files reload as their trigger files are re-read, not eagerly. `/usage`'s cost block and the
  status-line JSON both expose `context_window.used_percentage` / `.remaining_percentage` /
  `.context_window_size` (`02-claude-code.md:573-575`) — a flat, machine-readable percent, exactly the shape
  `ContextUsage.pct` already is.
- **opencode.** The sidebar's context widget: `tokens = input + output + reasoning + cache.read + cache.write`,
  `percent = Math.round(tokens / model.limit.context * 100)`, rendered as three separate lines — `"{tokens}
  tokens"`, `"{percent}% used"`, `"{money} spent"` (`01-opencode.md:164-166`, source
  `R:packages/tui/src/routes/session/sidebar.tsx`, i.e.
  `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/routes/session/sidebar.tsx`, fetched
  2026-09-20). `/compact` (alias `/summarize`, keybind `<leader>c`) maps straight to `POST /session/:id/summarize`
  (`01-opencode.md:260,303`, `R:packages/web/src/content/docs/tui.mdx`) — no colored grid, just a percent and a
  token count, always visible in the sidebar rather than gated behind a command.
- **Codex CLI.** Has `/compact` too (`04-codex-cli.md:456`, `RAW/codex-rs/tui/src/slash_command.rs`,
  `https://raw.githubusercontent.com/openai/codex/2426ed7684c87f9a627c60b54271cfed77c979df/codex-rs/tui/src/slash_command.rs`)
  — but its own `available_during_task()` gate returns **false** for `Compact` (`04-codex-cli.md:461`), i.e. Codex
  makes `/compact` **idle-only**. This is the opposite of what JevCode's contract wants: `Engine.compact?()`'s own
  doc comment (`types.ts:1774-1778`) frames it as `/compact now` **during** a run, folding history to make room for
  the *next* step's prompt — an idle-only gate would make the JevCode verb pointless (there is no next prompt being
  built when idle). Recommendation in §5 keeps JevCode's `/compact` live-only, the opposite of Codex's choice, for
  exactly this reason.
- **Aider.** `/tokens` — *"Report on the number of tokens used by the current chat context"*
  (`https://aider.chat/docs/usage/commands.html`, fetched 2026-09-22), broken down by component (system messages,
  chat history, repo map) against the model's context limit — the same per-section-with-chars shape §8.7 wants for
  `/context`, from a much older, simpler tool.
- **Cursor.** A live "N% context used" indicator in the composer header, hover reveals "X / Y tokens used"; at
  100% Cursor **drops old messages** rather than summarizing (per the Cursor community forum threads surfaced by
  search, e.g. `https://forum.cursor.com/t/where-did-context-window-fill-indicator-go/156687`, and
  `https://tokenlimits.app/blog/cursor-context-window`, both 2026). This is the behaviour JevCode's §8.5 "never
  truncated silently" rule is explicitly designed to avoid — every clip in JevCode's design carries a recovery
  pointer (`jevcode:outputs/step-<n>.txt`); Cursor's lossy-truncation-at-100% is the cautionary counter-example, not
  a pattern to copy.
- **tmux.** No analogue: tmux has no LLM context concept, so nothing here transfers from it; the brief's tmux
  mention is more relevant to round 5's session/activity topics than to this one.

---

## 3. Edge cases

1. **`status.context` absent.** Three of four `EngineMode`s never populate it (§1.5): `jev-off` (different engine
   class entirely), `jev-only`, `llm-jev`. The status cell must guard on `s.status?.context !== undefined` (mirrors
   the existing `s.status?.generatorTokens` pattern at `status/lines.ts:439-447`) and simply not render — no
   placeholder, no `ctx —%`. `/context` needs a *distinct* sentence for "this mode does not build a relaxed
   context" versus "no run is live" versus "before the first prompt" (three different reasons for an empty view).
2. **0-window / a tiny model.** `contextBudget()` (`src/loop/context/limits.ts:60-79`) already clamps to
   `windowTooSmall: true` when the budget would exceed 90% of the model's window, and `formatBudget`
   (`meter.ts:97-98`) already has the sentence: `budget <N> chars — capped by the <M>-token model window`. Nothing
   for the TUI to build here beyond wiring the string through; a genuinely 0-token window (a misconfigured pricing
   row) hits `Math.max(1, …)` floors in `computeContextUsage` (`meter.ts:38-39`) so `pct` never divides by zero.
3. **Resume with a stale summary.** On resume, `this.summary` stays `null` until the first lazy read
   (`engine.ts:3341-3343`) — so a resume card built *before* that read (i.e. from `snapshotState()` immediately
   after `createEngine` resolves, before the first `contextView` call) would see `summaryAt` set but the summary
   text not yet loaded. `/context`, if it wants the text, must call `store.readContextSummary()` itself (§1.6) —
   which sidesteps the engine's own lazy-load timing entirely, since it is a fresh disk read, not a wait for the
   engine's internal state.
4. **Resume seeded from `lastPromptChars` only.** The resume card's `ctx 41%` cell (§7.3 step 2 of
   `COORDINATION-DESIGN.md`) is explicitly built from `CheckpointState.lastPromptChars?` alone, and the card **omits
   the `ctx` cell rather than printing a zero** when the field is missing (older checkpoints, or a run that never
   built a prompt). This asymmetry — the live status cell shows `pct: 0` before the first prompt (`engine.ts:954`,
   `restoredContextUsage`), but the *resume card* omits the cell entirely when there is no persisted number — must
   not be collapsed into one code path; they are deliberately different (a live `ctx 0%` is informative, a resumed
   `ctx 0%` before any read would be a lie).
5. **The `·` glyph is hardcoded, not glyph-set-aware.** `formatMeter`/the design's own pinned string uses a literal
   Unicode `·` (`meter.ts:112`, and the design doc's own §8.6/§8.7 text). Every *other* dot separator in the TUI
   goes through `GLYPHS`/`glyphSet(ascii)`'s `g.dot` (unicode `'·'`, ascii `'-'`, `src/tui/glyphs.ts:116,168`),
   exactly as `modeBadgeWord` does (`status/lines.ts:107`: `.replaceAll(' · ', ' ' + g.dot + ' ')`). If the status
   cell calls `formatMeter` verbatim under `--ascii`/`NO_COLOR`/`TERM=dumb`, it leaks a raw Unicode dot — breaking
   the twin. This is a real, previously-unflagged inconsistency between a harness-owned pure function and a
   TUI-owned rendering convention (see §5 for the fix).
6. **Amber/red has no engine event, so no toast and no transcript record today.** Unlike money (`budget:warn` fires
   at 50/80/95%, a real `EngineEvent`, transcript item, and toast — `budget/lines.ts:56-65`, `BUDGET_THRESHOLDS`),
   there is no `context:warn`-shaped event (`grep -n "type: 'context" core/types.ts` finds only `context` — the
   unrelated jev-only stage-progress event — and `context:compacted`). Amber/red at 85/95% is **purely a colour
   change** in the design's own text (§8.5). A colour-only signal violates TD §14.1's "a marker beside every colour"
   rule (`docs/TUI-DESIGN-4.md:2351`, already applied to diff rows' `+`/`-`/`@@`/`···` markers) — screen-reader and
   `NO_COLOR` users get nothing at all today if this ships as colour alone.
7. **`compact?.()` returning `void` can't distinguish "absent" from "did nothing".** `typeof engine.compact ===
   'function'` tells you the method exists (false for `jev-off`'s generator-only engine, §1.5); but when it *does*
   exist and is called while idle-safe-guarded-out (`view:'legacy'`, `compaction:'off'`, or `foldableCount() === 0`,
   `engine.ts:1520-1521`), it silently returns with no signal. The only way to tell "it folded something" from "it
   was a no-op" is to compare `engine.status().context?.compactions` before and after the synchronous call —
   `compact()` increments `this.compactions` and calls `emitStatus()` before returning (`engine.ts:3554,3565`), so
   the comparison is safe and synchronous.
8. **A run whose `outputs/` are not mirrored.** §8.5's two-cause rule (import vs. local eviction) already has a
   coded distinction (`outputEvicted` on `HistoryEntry`, `types.ts:1697`) — `/context`'s per-file / per-step detail
   must read that flag before claiming a pointer is dead, not just check file-not-found.

---

## 4. Pinned strings and twins

| Surface | String (verified source) | Twins needed |
| --- | --- | --- |
| Status cell | `ctx 41% · 6 files · 12 steps` — `formatMeter`, `src/loop/context/meter.ts:112` (byte-identical to `COORDINATION-DESIGN.md` §8.7/§12.0.3) | `--plain`: same text, one line, no colour. `--ascii`/`NO_COLOR`: **must not** call `formatMeter` verbatim — substitute `g.dot` (§3.5) or accept the raw `·` only where `NO_COLOR`/`--ascii` don't apply. Screen reader: not separately announced (matches how `run $`/`sess $` cells are also silent — only a *crossed threshold* should announce, see below). 40 cols: likely dropped first or never shown (see §5 threshold). 80/120 cols: fits comfortably (18-24 cells). |
| `/context` header | `budget 70k of 128k window (55 %)` — `formatBudget`, `meter.ts:91-101`; the money-capped form `budget 96k chars — capped by the $2.00 run cap at 40 steps (est. $0.014 per step)`; the window-floor form `budget <N> chars — capped by the <M>-token model window` | `--plain`: identical block text (this is inline-only content, same convention as `/diff`/`/plan`). `--json`: the raw `ContextUsage` object, already reachable via `--json=verbose`'s `status` event (§1.1) — a synchronous `/context --json` should reuse the same shape, not invent a second one. |
| `/context` recent-steps line | `recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)` — `formatRecentSteps`, `meter.ts:86-90` | same as above |
| Compaction notice (as it renders **today**, with no round-5 work) | `compaction: <before> → <after> prompt chars (code); <N> steps folded into the summary at step <S> (<why>)` — real notice text at `engine.ts:3567`, **not** the design's pinned `compaction: 41k → 12k chars (code)` (§1.4) | Already identical across `--plain`/`transcript.log`/TUI (it's a generic `notice` item, `plain.ts:353-358`). Round 5 must decide which string is canonical (§5) before adding any TUI-side decoration. |
| `/compact` idle refusal | `error: /compact needs a live run` — free, from `availabilityError(spec, live)` (`registry.ts:599-603`) once `/compact`'s `CommandSpec.availableDuringTask` is `'live'` — no bespoke string needed. | Same function serves Ink, `--plain`, and the palette; no twin work. |
| `/compact` while live, folded something | Should read like the design's `/compact now` hint disappearing plus a line naming what happened — reuse the compaction notice above; do not invent a second string for the manual trigger (the event's `by`/trigger reason already distinguishes `(requested)` from `(every 8 steps)` etc., confirmed at `test/unit/loop/engine-context.test.ts:242` expecting `/ \(requested\)$/`). | — |
| `/compact` while live, nothing to fold | New string needed — nothing pinned anywhere yet. Recommend: `nothing to compact — only the newest step is in history` (mirrors `foldableCount() === 0`'s condition in plain language). | `--plain` identical; screen reader identical (short, no colour). |
| `/compact` in a mode with no relaxed context | New string needed. Recommend: `this run does not build a relaxed context (jev-off / jev-only / llm-jev) — nothing to compact`. | same |
| Resume card `ctx` cell | `ctx 41%` inline in the §7.3 card, from `CheckpointState.lastPromptChars?`; **omitted** (not zeroed) when absent (`COORDINATION-DESIGN.md:1264-1267`) | `--plain` card: same omission rule. |
| Amber/red marker (needed, not yet designed) | No pinned text exists. Needs a TD §14.1-compliant word/marker, e.g. mirroring `meterWord`'s convention (`budget/lines.ts:56-65`: `ok`/`half`/`high`/`critical`/`over`) — recommend `ctx 87% amber · /compact now` / `ctx 96% red · /compact now` (word chosen to match `MeterLevel` from `src/loop/context/meter.ts:83`, already `'ok'\|'amber'\|'red'`). | Colour + word together satisfy `--ascii`/`NO_COLOR`; screen reader gets the word via a one-time crossed-threshold notice, not a live-region read of the status bar (matches how `budget:warn` is announced, not the status line itself, per `docs/TUI-DESIGN-4.md §5.8`). |
| `context.*` config rows | None exist (§1.3). Recommend `context.mode` (`'relaxed'`\|`'legacy'`), `context.compaction` (`'code'`\|`'llm'`\|`'off'`), `context.kept` (`'code'`\|`'jev'`), `context.compactEvery` (integer, 0 disables), `context.budgetChars` (override) — one row per `ContextPolicyOptions` member (`types.ts:1731-1740`). | `jevcode config` prints/validates them exactly like `ui.renderer` (`config/defaults.ts:161-162`, `config/ui.ts:16-19,66-67`) — `enumSetting`/an integer parser, same pattern. |

---

## 5. Recommended decisions

**D1. Status-cell placement and drop priority.**
Options: (a) insert `ctx` into `SegmentId`/`DROP_ORDER` between `'tokens'` and `'git'` (own gate, e.g.
`CONTEXT_MIN_COLUMNS = 100`, same tier as git/sparkline, dropped before `sess` but after `git`/`spark`); (b) tie it
to the existing `TOKENS_MIN_COLUMNS = 160` gate since both are "how much of the model I'm using" facts; (c) make it
unconditional (like `step`/`run`) since it's the one signal that tells a user *why* the next step might be slow or
expensive.
**Recommendation: (a).** Money (`run`/`sess`) must never be dropped ahead of context (spend is the harder cap); at
40 columns neither `tokens` nor `ctx` fits regardless. Add `'ctx'` to `SegmentId` and to `DROP_ORDER` positioned
*before* `'sess'` (i.e., ctx drops before session spend, after git/spark) — mirrors the existing precedent that
per-run money outranks every other cell. Gate at `CONTEXT_MIN_COLUMNS = 100`, same as git/spark, since neither
survives to the 80-column default terminal either; 40-column behaviour is "not shown," 80-column is "not shown,"
120-column is "shown, three cells before `sess` in the drop order."

**D2. Reuse `formatMeter`/`formatBudget`/`formatRecentSteps` verbatim, but fix the glyph leak first.**
Options: (a) call the harness's `src/loop/context/meter.ts` functions directly from `status/lines.ts` and
`/context`'s block builder (single source of truth, guaranteed `--plain`/Ink/`transcript.log` parity); (b)
reimplement the same strings inside `src/tui/status/lines.ts` with `GLYPHS`-aware dots, risking drift.
**Recommendation: (a), plus a cross-slot request** to whichever harness slot owns `src/loop/context/meter.ts`: add
an optional `g: GlyphSet` parameter to `formatMeter` (default `GLYPHS.unicode`), matching `modeBadgeWord`'s existing
signature (`status/lines.ts:107`) — a one-line, additive, test-covered change, not a redesign. Until that lands,
round 5 can special-case `--ascii` by doing a string `replaceAll('·', '-')` on `formatMeter`'s output at the call
site as a stopgap (safe because the string's only non-ASCII character is the dot).

**D3. Amber/red needs a text marker and a one-time notice, not silent colour.**
Options: (a) colour only (violates TD §14.1); (b) append a word (`amber`/`red`) to the status cell only, no
notice; (c) append the word **and** fire a local, engine-independent one-time toast/notice on first crossing 85%
and 95%, computed client-side from `status.context.pct` on every `status` tick (no new `EngineEvent` needed —
mirrors `crossedThresholds`'s pattern in `budget/lines.ts:68-73`, but kept entirely in the TUI/CLI controller since
there is no `context:warn` event to hook).
**Recommendation: (c).** It is the only option that gives screen-reader and `NO_COLOR` users the same signal sighted
users get from colour, and it costs no engine change (the controller already has `status.context.pct` on every
tick). Use `engine.annotate()` (`types.ts:1780-1782`, already used for "a renderer-originated transcript line while
the run is live") to write the crossing notice so it lands in `transcript.log` too, exactly once per threshold per
run.

**D4. `/compact`'s availability and the "did nothing" problem.**
Options: (a) `availableDuringTask: 'live'` (matches `Engine.compact?()`'s intent, opposite of Codex CLI's idle-only
choice, §2); (b) `'any'`, printing a different message when idle.
**Recommendation: (a).** The verb is meaningless idle (no next prompt to make room for), and `availabilityError`
already gives the idle refusal for free (§4's table). For the "did nothing" ambiguity (§3 edge case 7): compare
`context?.compactions` before/after the synchronous call and pick among the three new strings in §4's table
(mode-absent / nothing-to-fold / folded-something-see-the-notice) — no engine change needed, since `compact` is
already synchronous and `status()` is a synchronous pull.

**D5. `/context`'s data sources — combine three reads, not one.**
Options: (a) `EngineStatus.context` alone (insufficient — no file list, no summary text, §1.6); (b) add a large new
`Engine.contextDetail?()` method that returns everything in one call (a bigger contract change, cross-slot); (c)
combine what already exists: `engine.status().context` for the numeric header, `engine.snapshotState()` for the
file list/history (already synchronous, already used for last-resort writes), and the run's own
`CheckpointStore.readContextSummary()` (already exported, already atomic) for the summary text.
**Recommendation: (c) now, (b) as a follow-up if the three-source join proves awkward in practice.** (c) needs zero
contract changes — every piece it touches (`snapshotState`, `hasContextStore`, `readContextSummary`,
`createCheckpointStore`) is already public and already used by `src/cli/session.ts` for the idle-run/resume path.
Scope `/context drop <file>` and `/keep <text>` **out** of the round-5 MVP (§1.7) — they need new `Engine` write
methods that do not exist, unlike `/compact`.

**D6. `context.*` config: land the whole chain, not just the schema row.**
Per §1.3, a schema row alone changes nothing observable. Recommend one PR that adds: the `SettingName` rows, a new
small `resolveContextPolicy`-shaped function in `src/config/resolve.ts` (mirroring `resolveUiConfig`) wired to
`ResolvedConfig.context()`, and the one-line `contextPolicy: rcfg.context?.()` addition at each
`createEngine`/`defaultEngineFactory` call site already present in `src/cli/session.ts`. Without the third piece,
the first two are dead code exactly like `ResolvedConfig.context?()` is dead today.

**D7. Keep the harness's actual compaction notice text; do not chase the design's `k`-abbreviated pin.**
The as-built string (§1.4) is more informative than the design's pin (it names the fold count, the step, and the
trigger reason) and it already has test coverage pinning its shape
(`test/unit/loop/engine-context.test.ts:236-260`). Changing it to match the design's shorter pin would touch
harness-owned `engine.ts` for a strictly worse string. Recommend updating the *design doc* to match the as-built
string instead (a documentation fix, filed as an open question to the peer, §6) — and build the TUI's optional
`─ compaction ─` decoration (§8.6's "the TUI may decorate... but never replace") around the real string.

---

## 6. Open questions

1. Should `formatMeter`/`formatBudget`/`formatRecentSteps` in `src/loop/context/meter.ts` take a `GlyphSet`
   parameter (mirroring `modeBadgeWord`), or should the TUI post-process their output for `--ascii`/`NO_COLOR`? Both
   work; the former is the smaller footgun for future harness edits to these strings (§5 D2).
2. Is the compaction notice's wording (`compaction: <before> → <after> prompt chars (code); <N> steps folded…`,
   `engine.ts:3567`) the intended, final string, or should `docs/COORDINATION-DESIGN.md` §8.6's pin
   (`compaction: 41k → 12k chars (code)`) be reconciled to match it — and if the design's shorter form is actually
   wanted, is that a harness-side string change or a TUI-side re-decoration that drops information?
3. Should amber/red context-threshold crossings get their own `EngineEvent` (a `context:warn`-shaped member,
   symmetrical with `budget:warn`), or is a client-side, engine-independent computation (this doc's D3) sufficient
   forever? A dedicated event would also make the crossing visible to `--json=verbose` consumers without polling
   `pct` themselves.
4. `Engine.snapshotState()` + `CheckpointStore.readContextSummary()` (§5 D5) is proposed as the `/context` data
   source with no contract change. Is there a reason the harness session would prefer a single new
   `Engine.contextDetail?()` accessor instead (e.g., to avoid the TUI depending on `buildCheckpointState()`'s
   incidental completeness, or to keep file-layout knowledge — `CHECKPOINT_FILES.context`/`CONTEXT_SUMMARY_FILE` —
   entirely inside `src/checkpoint/**`)?
5. `/context drop <file>` and `/keep <text>` need new `Engine` write methods (§1.7). Are these planned for round 5,
   or should this topic's slot (R5-3) scope them out entirely and file them as a round-6 / harness-contract item
   alongside `/end`, `AgentSupervisor`, and the other not-yet-landed contract members the digest already names?
6. Should `Heartbeat.context`'s stale `windowBudget` field (§1.8) be renamed to `budgetTokens`/`windowTokens` now
   (cheap, since nothing reads it yet) or left until the `'coordinate'` micro-stage is actually wired into
   `engine.ts` (per the digest's own open question 2), on the theory that touching dead code twice is wasted work?
7. Given `contextEnabled` excludes `jev-only` and `llm-jev` by design (§1.5), should `/context` in those modes say
   nothing more than "not available in this mode," or is there value in showing Jev's own `recent`/`window` bounds
   (`STATE_LIMITS`, unrelated to `ContextUsage` but the only "context" `jev-only` actually has) so the command isn't
   simply absent for 50% of the engine's modes?
