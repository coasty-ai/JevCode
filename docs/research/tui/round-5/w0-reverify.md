# Round 5 — W−1/W0 re-verification sweep

**Tree:** `.claude/worktrees/r5-impl`, branch `r5-impl`, HEAD `36f1104`. **`git rev-parse HEAD` == `git rev-parse main`**,
so the W−1 rebase of §9.3 is a **no-op**: this worktree *is* `main` at its fork. Every commit `TUI-DESIGN-5.md` names as
"on `main`, not here" is an ancestor of HEAD — `2400a0c` (contract 1.5), `d8490fa`, `7efac12` (W2b), `c7087e2`
(`BlockingKind`), `1aa720e` (contract 1.6), `aa7dc3c` (contract numbers), `f9d033e`, `751e3bf`, `2e20108`, `5291e9b`,
`6d46875`, `d860827` — all **ANCESTOR**. Verified 2026-09-22 by `git merge-base --is-ancestor`.

**Consequence for every slot:** `docs/TUI-DESIGN-5.md` was written on `r5-design`, an ancestor of `main`. Roughly every
`src/core/types.ts` line number in it is short by **200–600 lines**, and a large fraction of its "not built, verified by
absence" rows are **now false**. Use the anchors in this file, not the design's line numbers. Gate **G-R5-11** is
satisfied by this document.

**Every `src/core/types.ts` line number below is the tree AFTER this W0 commit** (the contract block adds ~120 lines,
so a pre-W0 `grep` will be short by that much below `:750`). Other files' numbers are untouched by W0.

---

## 1. The §2.0 coordination table — re-read

| Design row | On this tree | Verdict |
| --- | --- | --- |
| `Fold`, 14 fields | `src/coordination/types.ts:353` (was `:327–366`) | **moved**, shape unchanged |
| `Ledger` (7 members) / `LedgerHandle extends Ledger` | `types.ts:492` / `src/coordination/ledger.ts:189` | **`ledger.ts:189` exact**; `Ledger` moved. **There is NO `Ledger = LedgerHandle` alias** and per §15.2 there never will be — R12 is CLOSED as "will not do"; D-AD (b) is permanent |
| `SessionActivity` (18 fields) | `types.ts:460` (was `:434–458`) | **moved**, shape unchanged |
| `listSessions(fold, self, {all?})` | `src/coordination/fold.ts:387` | **exact** |
| `claimRefusal(local, foreign)` | `src/coordination/claims.ts:265` | **exact**, still **zero callers** |
| `ForkVerdict`/`ForkRole`/`forkVerdict`/`unverifiedFork` | `claims.ts:220`(ForkRole)/`:246`(forkVerdict) | design's `:220`/`:222` are swapped; `forkVerdict` is `:246` as cited |
| `compareClaim` | `claims.ts:85` | **exact** |
| `lockReplaceVerdict` | `src/coordination/records.ts:832` (was `:829`) | **moved 3**; still no caller under `src/session/**` (R6 open) |
| `isLive(record, now, arrival, env, origin)` | `records.ts:717` (was `:714`) | **moved 3** |
| `Engine.pause/end?/deliver?` | `src/core/types.ts:2225` / `:2227` / `:2229` (was `:1769`/`:1771`/`:1773`) | **moved ~434** |
| `PauseOptions` | `:2016` (was `:1582`); `PausePoint` `:1985`, `PausePointReason` `:1974`; `EndOptions` `:2024`, `RunEnded` `:2031` | **moved ~412** |
| `BlockingAnswer` has `'wait'`/`'worktree'` | `:1486` (was `:1226`) | **exact in substance** |

### Rows the design marks "not built" that are now BUILT

1. **`BlockingKind` has both members** — `src/core/types.ts:1484` is now 8 members including `'land-preflight'` and
   `'lease-conflict'` (commit `c7087e2`). **§8.2 R1 is CLOSED.** The four placeholder consumers landed with it and are
   already *styled*, not placeholders: `pausedWord` (`src/tui/status/lines.ts:303,:305`), `blockingRowsStructured`
   (`src/tui/blocking/lines.ts:260,:262`), `blockingStatusWord` (`:346,:348`), and
   `test/unit/tui/pane/blocking.test.ts:37` (`ALL_KINDS`, 8), `:54/:56`, `:70/:71` (keys `[c][s][x]` and `[w][c][t][q]`).
   R5-2's §2.11 work is therefore **restyling + the pane's rows/twins/keys**, not "build behind an `it.skip`".
2. **`ConfirmRequest.title/headline/body/badge`** — `src/core/types.ts:804–827`, all four optional. **R5 CLOSED.**
3. **`StageName 'coordinate'` and `'decompose'`** — `:273`, 10 members. `StepRecord.coord?: StepCoord` at `:499` (`StepCoord` at `:459`).
   `StepTiming.coordinateMs?/coordWaitMs?` present. **R10/R11 CLOSED.** `TIMELINE_EXCLUDED_STAGES` is exported
   (`src/tui/pane/timeline.ts:23`) and `PENDING_TUI_STAGES` is **gone**.
4. **`EngineOptions.coordination: CoordinationOptions`** — `:1625`, interface at `:1507`. The policy field **is
   `claims`** (`'advisory' | 'strict' | 'off'`), not `leases`, exactly as §15.2 says. Note: `SessionActivity.leases`
   (the fold's per-session array) **keeps** its name — only the *option* is `claims`.
5. **`EngineStatus.coordination?: CoordinationStatus`** (`:1803`, shape at `:1811`), **`EngineStatus.phase?:
   EngineRunPhase`** (`:1799`, union at `:280`), **`EngineStatus.subwork?`** (`:1801`).
6. **`NoticeKind` carries `'coordination'` and `'session'`** (and `'import'`, `'orchestration'`) — `:1839`, 16 members.
7. **Events `coordination:facts` (`:1920`), `coordination:decision` (`:1925`), `session:message` (`:1933`)**.
8. **`Heartbeat.context` is already `{ …, budgetTokens, windowTokens, … }`** (`src/coordination/types.ts:163`);
   `windowBudget` is gone. §15.1 Q17 is landed — read the new names.
9. **`SegmentId` already has `'peers'`** — `src/tui/status/lines.ts:410`, **9 members, and NOT exported**
   (`type SegmentId`, no `export`). `DROP_ORDER` (`:426`) is already 6 entries **beginning with `'peers'`**, and
   `StatusZones['dropped']` (`:535`) already lists `'peers'`. See §5 below — this changes R5-2's §2.2 hunk materially.
10. **`src/loop/stages/decompose.ts` EXISTS** (`decomposeBody` at `:254`, used at `:493`). **N1's last stated blocker
    is gone**; R15 (delete `decomposeBody` once `src/tui/agents/lines.ts` renders the rows) is live, not hypothetical.

### Rows the design marks "not built" that are STILL not built

| Thing | Anchor | §8.2 / slot |
| --- | --- | --- |
| `UiLabel` had no `'[session]'` | now `src/core/types.ts:1849` | **landed by this W0 commit** (item 2) |
| `SessionRow` had no `ended?`/`parentSessionId?`/`workspaces?` | now `:2481` | **landed by this W0 commit** (item 3) |
| `SessionHost` had no `who?()` | now `:2338`, the method at `:2381` | **landed by this W0 commit** (item 4) |
| `INDEX_KINDS` is 8 kinds, **module-private**, typed `readonly string[]` | `src/session/index.ts:36`; `IndexKind = IndexLine['kind']` already at `:35` | R5-1, W4 (D-AS) |
| `src/cli/sessions.ts` dispatcher: `list \| reindex \| prune \| unlock` only | `src/cli/sessions.ts:135–141` | R5-1, W2 |
| no `who`/`inbox`/`tell`/`headsup`/`request`/`end`/`peers` command row | `src/tui/commands/registry.ts`, **41 rows** (round 4's 37→41 landed) | R5-2, W4 |
| no `coordination.*` `SettingName` | `src/config/types.ts` | R5-2 rows via R5-3's PR, W4 |
| pause index line carries no `by` | `src/cli/session.ts:1736` (was `:1550`) | R5-1/R5-2, W4 |
| `FactKey` is 14 members, no `peers`, no `memory` | `src/chat/facts.ts:17` | R5-1 / R5-5 |
| `claimRefusal` has zero callers; `resumeRun` is at `src/cli/session.ts:2488` (was `:2296`) | | R5-1, W4 |

---

## 2. The §3.0 context table — re-read

| Design row | On this tree |
| --- | --- |
| `EngineStatus.context?: ContextUsage` | `src/core/types.ts:1788` (was `:1455`) |
| `ContextUsage`, **19** members | `:2095` — **28 members now**: the 19 plus `memory?: MemoryUsage` and the nested `compaction { chars, allowanceChars }`. `ContextUsage.memory?` at `:2134`; `MemoryUsage` at `:3442`, 9 fields, exactly §0.3 item 2 |
| `RecentStepsUsage` | `:2138` (was `:1682`) — unmoved by chance |
| `Engine.compact?()` | `:2235` (was `:1779`) |
| `formatMeter` / `formatBudget` / `formatRecentSteps` | `src/loop/context/meter.ts:145` / `:116` / `:109` (design said `:109`/`:95`/`:89`) — **all three moved ~+25**; none takes a `GlyphSet` (R4 still open, stopgap stands) |
| **`formatMemory(u): string \| null`** | `src/loop/context/meter.ts:133` — **BUILT** (§0.3 item 2 landed) |
| `MeterLevel` + 85/95 thresholds | `meter.ts:87`, `:103–104` via `METER_RED_PCT`/`METER_AMBER_PCT` from `./limits.js` |
| the compaction notice | `src/loop/engine.ts` — as-built string unchanged (D-AJ (b) stands) |

### What changed under D-AI / D-AG — **read this, R5-3**

- **`context.*` settings ALREADY EXIST — six rows, not zero.** `src/config/types.ts:34–39`:
  `context.mode`, `context.compaction`, `context.compactEvery`, `context.historySteps`, `context.fileCacheBytes`,
  `context.budgetChars`; `SETTINGS` rows at `src/config/defaults.ts:159–164` (env + fileKey, **no CLI flag**).
  The design's §8.1 item 7 list (`context.mode · compaction · kept · compactEvery · budgetChars`) is **stale on three
  counts**: `historySteps` and `fileCacheBytes` exist and are not in it, and **`context.kept` does not exist** — it is
  the one row of D-AI's five that is genuinely missing. CD row 101's "zero rows in the `SETTINGS` schema" is FALSE.
- **`ResolvedConfig.context()` IS implemented** — `src/config/resolve.ts:724`, with a long docblock at `:713–723`
  explaining exactly which three members always resolve. §8.1 item 8's "DECLARED but never implemented" and the
  "false doc comment" clause are both **CLOSED**. `ResolvedConfig.context?()` is at `src/core/types.ts:2661`; `EngineOptions.contextPolicy?` at `:1537`.
- **The last layer is still missing and is the whole of D-AI's remaining work:**
  `grep -rn contextPolicy src/cli/` → **zero hits**. No `createEngine`/`defaultEngineFactory` call site passes
  `contextPolicy: rcfg.context?.()`, and `rcfg.context` has **no caller anywhere in `src/`**. So the resolver is
  currently dead code — exactly the state D-AI exists to prevent, but one layer further along than the design assumed.
  **§9.3 constraint (c) shrinks to: R5-3 lands `context.kept` + the two `src/cli/session.ts` call-site lines.**
- **`context:warn` EXISTS** — `src/core/types.ts:1941`
  (`{ type: 'context:warn'; step; pct; budgetTokens; tokensInWindow }`), emitted at `src/loop/engine.ts:4784` behind
  `contextWarnCrossed(before, u.pct)` with the "once per upward crossing" comment at `:4781`. §15.1 Q16 **landed**;
  N5's "no new EngineEvent" is satisfied by the harness having added it. D-AG's amber word fires on the event.
- **R13 is STILL OPEN and still blocks requirement 3 in the default mode.**
  `src/loop/engine.ts:1130` (was `:922`): `this.contextEnabled = this.contextPolicy.view === 'relaxed' && (this.mode
  === 'jev-on' || this.mode === 'jev-off');` — `'llm-jev'` is **not** in it, and `DEFAULT_MODE` is `'llm-jev'`
  (`src/config/defaults.ts:60`, was `:50`). §1.1's caveat stands verbatim.

---

## 3. The §4.1 agent-tree table — re-read

- `src/orchestrate/index.ts` still exports the 23 types + `DEFAULT_SPLIT_POLICY`; `AgentState` is still the 16-member
  union. D-AK (b) is still buildable **but is now optional**: contract 1.5 is on this tree, so the types are also in
  `src/core/types.ts`. `test/unit/core/contract.test.ts` already imports `AgentRow`/`AgentState`/`Manifest`/… from
  **`src/core/types.js`**. **Recommendation to R5-4: import from `src/core/types.js` directly and skip the re-point** —
  `src/orchestrate/index.ts` is a value module reaching `node:fs/promises`, so `core/types.js` is strictly safer for
  G-R5-1 and costs nothing now that 1.5 has landed. (`import type` only from `orchestrate/index.js` if you must.)
- **`EngineStatus.orchestration?` EXISTS** — `src/core/types.ts:1793`:
  `{ manifestId: string; agents: number; live: number; landed: number; reserveUsd: number; heldUsd: number } | null`.
  **§8.2 R3 is CLOSED**; §8.4's "local `OrchestrationStatus` stub" row is dead. Note the shape is **six scalars**, not
  OR §4.1's row array — §4.4's collapsed strip must be built from these six, and `SessionHost.agents?(): readonly
  AgentRow[]` (`src/core/types.ts:2383`) is the row source.
- **`meter.hold/release/heldUsd` + `RESTORED_HOLD_ID` all landed** — `src/spend/meter.ts:50,:69,:152,:160,:166`.
  **R2 CLOSED.** Round 5's four call sites are already done too: `sessionRemainingUsd(cap, spent, heldUsd = 0)`,
  `childCapUsd(...)`, `followUpDecision(...)` at `src/tui/budget/lines.ts:201,:207,:215`, and both `src/cli/session.ts`
  sites (`:2210`, `:2539`) already pass `sessionMeter.heldUsd?.() ?? sessionMeter.snapshot().heldUsd ?? 0`.
  **`heldUsd` is optional on `SpendMeter` — keep the `?.()` idiom (§15.2).** `/cost` can show `held`/`free` today.
- `PausePointReason` has `'delegate'` and `'review-needed'`; `decompose:skipped` is `--json=verbose` only
  (`src/core/types.ts:1946`); `jevCacheHits` is on `StepRecord` (`:515`) and `jevCacheHitsOf` is in
  `src/cli/session.ts:1196` — §0.3 item 6's list is fully landed, including the `/jev` cache-hits row (HEAD `36f1104`).
- `EXCLUSIVE_COMMANDS` is at `src/cli/session.ts:222` (was `:218`), **11 members**, unchanged.
- **Round 4 is merged**: `src/tui/block/lines.ts`, `src/tui/fit.ts` (`fitRung`, `fitRungIndex`, `fillRung`,
  `fitRungIn`), `src/tui/gutter.ts` (`LABEL_GUTTER = 10`, `gutterMode`), `src/tui/diff/{rows,summary,text}.ts` all
  exist. **§8.4's whole stub table is dead.** `src/tui/plain.ts:904` is `CONFIRM_HEADER_ROWS = 8` (was `:517`).

---

## 4. The §5.0 import table and §6.0 provider table — re-read

**Import (§5.0).** Every symbol exists; the line numbers moved by ~+5 to +7:
`newImportId` `:161`, `isImportId` `:168`, `planImport` `:328`, `probe` `:591`, `summarisePlan` `:655`,
`applicableRows` `:687`, `asImportPlan` `:701`; `applyPlan`/`resumeImport`/`undoImport` re-exported at `:135/:143/:146`;
`ImportWriteFs` at `src/import/types.ts:216` (design said `:484`); `render`/`sourcePath` are `ApplyOptions` fields at
`src/import/apply.ts:391`/`:393` (exact).
- **`secretId(candidateId)` is exported** — `src/import/plan.ts:1129`, re-exported from `src/import/index.ts:125`.
  §0.3 item 1 is landed: **no fixture may spell `secret_0`**.
- **`EngineOptions.memory?: EngineMemoryOptions`** `:1581` (interface `:3428`), **`RunMeta.imports?`** `:1279`,
  **`NoticeKind 'import'`** `:1839`, **`InstructionRecord.kind?/scope?`** `:1315–1322`, **`CheckpointState.kept?`**
  with `'memory'` `:1149` — all §0.3 item 4 items are **landed**. Nothing for R5-5 to request here.
- **`renderReport`/`renderPlanJson` already thread the exact layer** — `src/import/report.ts:298`, `:320` call
  `redactSecrets(text, exactLayer(opts))`. **§8.2 R7 is CLOSED** (§15.1 Q13's "a fix is running" has landed).
- Still absent, as designed: `Command` union has no `'import'` (`src/cli/args.ts:20`, 13 members);
  `src/cli/import.ts`, `src/config/imports.ts`, `src/tui/import/**` do not exist; `WizardStep`
  (`src/tui/onboarding/reducer.ts:26`) is 13 members, no `'import'`; `OverlayKind` (`src/tui/layout.ts:52`) is 10,
  `COLLAPSING` (`:58`) is 5; no `import.*`/`memory.*`/`seen.import` setting.

**Provider / models (§6.0).** Every symbol exists at the cited line: `ProviderId`/`PROVIDER_IDS`/`PROVIDER_KEY_ENV`/
`isProviderId`/`keyEnvNames` at `src/provider/ids.ts:18/:25/:36/:47/:52`; `PROVIDERS` at
`src/provider/registry.ts:174`; `instantCatalogue` at `src/models/list.ts:284`; `allStaticModels` at
`src/models/static.ts:220`; `rankModels`/`findModel`/`nearMisses`/`matchModel` at `src/models/search.ts:176/:210/:221/
:87`; `verifyProvider` at `src/models/verify.ts:37`; `modelSummary`/`sourceLabel`/`errorLabel`/`catalogueSummary` at
`src/models/format.ts:40/:67/:82/:101`; `recommend` at `src/models/recommend.ts:149`.
**Still open, unchanged:** `R14` (`PROVIDER_BASE_URL`/`PROVIDER_DISPLAY_NAME` are **not** in `ids.ts`; `BASE_URLS` is
still the two-entry table at `src/config/defaults.ts:77`, display names at `src/tui/onboarding/lines.ts:42`,
`providerDisplayName` at `src/models/providers.ts:183`); the two-entry private `PROVIDER_KEY_ENV` at
`src/config/resolve.ts:91` used at `:516`; the two-name throw at `src/config/validate.ts:161`; the inline key-env
ternary at `src/cli/session.ts:2004` (design said `:1818`); `/provider`'s `ArgSpec.values: ['anthropic','openrouter']`
at `src/tui/commands/registry.ts:365` (design said `:357`); `/model` handler at `src/cli/session.ts:3293` (was `:3071`).
**`R8` partly closed:** `src/core/redact.ts:68–75` now carries xAI (`xai-`) and Fireworks (`fw_`) with an explicit
comment that there is deliberately **no Meta row** until a real key shape is documented — §15.1 Q14 as promised.

---

## 5. Design lines that are WRONG against this tree (not merely moved)

1. **§8.1 item 10 / §9.2 `status/lines.ts` — `'peers'` already exists and `DROP_ORDER` already starts with it.**
   `SegmentId` is `'step'|'run'|'sess'|'tokens'|'git'|'spark'|'help'|'secret'|'peers'` (`:410`, **9 members, not
   exported**) and `DROP_ORDER` is `['peers','help','spark','git','sess','wall']` (`:426`). Round 5's amendment (i) in
   the preamble — "the `peers` segment sits **fifth** in `DROP_ORDER`, not first" — is therefore a **move of an
   existing entry**, not an append, and `StatusZones['dropped']` (`:535`) needs only `'ctx'` added, not `'ctx'` and
   `'peers'`. R5-2's W3 hunk must be rewritten accordingly; the round-4 test that pins today's order will need editing.
2. **§8.1 item 10 — `PickerOp` does not exist.** There is no exported `PickerOp` type in `src/tui/keys/resolve.ts`;
   the closed union is **inline** on the `KeyAction` arm at `src/tui/keys/resolve.ts:185`
   (`{ type: 'picker'; op: 'move'|'page'|'open'|'accept'|'preview'|'allWorkspaces'|'rename'|'deleteArm'|'deleteConfirm'|'close'; by?: -1|1 }`).
   R5-4's `keys/resolve.ts` hunk either extends that inline union or extracts a named `PickerOp` first — the design
   assumes the latter already exists. Design's `:169` is `historySearch`-adjacent, not the picker.
3. **§8.2 R12 will never land** — §15.2 reverses §15.1 row 1: no `Ledger` alias, `LedgerHandle` permanently.
4. **§8.1 item 7 `context.*` list is wrong** — see §2 above: six rows exist, `context.kept` is the only missing one.
5. **§8.1 item 8 is done** — `ResolvedConfig.context()` is implemented; only the call-site wiring remains.
6. **§2.0's `Engine.pause` consumer cell ("`pause` only, no `opts`")** — `SessionHost.pause` at
   `src/core/types.ts:2357` already carries `PauseOptions & { scope?: 'run'|'tree'|'agents'|'all'|\`agent:${string}\` }`
   (contract 1.5 [D15]). The scope half of D-AE's grammar therefore has a **typed destination today**, which the design
   says only the coordination half has.
7. **`Heartbeat` derivations §8.1 item 4 gets wrong (for R5-1's `activityView` mapper):**
   - `Heartbeat.spend` is `{ generatorUsd, jevUsd, sessionUsd: number | null, capUsd }` (`coordination/types.ts:151`),
     **not** `{ totalUsd, capUsd }`. `SessionActivityView.spend.totalUsd` must be derived
     (`sessionUsd ?? generatorUsd + jevUsd`) and that derivation belongs in the mapper's table test.
   - `Heartbeat.bench` is `{ benchId, tasks: { live, done, total }, lanes, spendUsd }` (`:150`), **not**
     `{ benchId, done, tasks, lanes }` — `done = tasks.done`, `tasks = tasks.total`.
   - `Heartbeat.subwork` is `SubworkEntry[]` (`:149`, `SubworkEntry.kind: 'sample'|'lane'|'probe'|'child'` at `:84`),
     **never null**. The view's `subwork: null` ("truncated away", §15.1 Q20) must be keyed off
     **`Heartbeat.truncated?: boolean`** (`src/coordination/types.ts:184`), not off the array — an empty array means "none" and renders
     `lanes 0 · samples 0`, `truncated === true` renders the `?` twin.
   - `Heartbeat.repo.branch` / `.head` at `:126–127`; `heartbeat.context.pct` at `:163`.
8. **§1.3 N1's "one remaining blocker" is gone** — `src/loop/stages/decompose.ts` exists. The supervisor's absence is
   now the only gap; R5-4 should re-read whether `paneTabsFor(hasDelegation)` can ever be true in this build.
9. **§8.4's entire stub table is dead** (round 4 merged; contract 1.5/1.6 landed; `heldUsd` landed; R1 landed).

---

## 6. What this W0 commit landed

`src/core/types.ts`
- `// contract 1.8 (2026-09-22): TUI round 5 …` header line, directly after the `1.7` line, nothing reordered.
- **item 2** — `UiLabel` gains `'[session]'` (7 members). `ChatLabel` is `Extract<…>` and is unaffected.
- **item 3** — `SessionRow` gains `ended?: RunEnded | null`, `parentSessionId?: string | null`,
  `workspaces?: readonly string[]`, all optional.
- **item 4** — `SessionHost.who?(): readonly SessionActivityView[] | null`, plus the new `SessionActivityView`
  (flattened projection of `SessionActivity` + its `Heartbeat`) and `SelfIdentityView` interfaces beside `PeerView`.
- **item 6** — `ProviderName = ProviderId | 'mock'`; `GeneratorConfig.provider: ProviderId`; a third type-only import
  `import type { ProviderId } from '../provider/ids.js'` (zero-import module, erased by `verbatimModuleSyntax`),
  re-exported beside the other four. **The whole tree type-checks with no other edit** — `validate.ts:161`'s two-name
  check still compiles as a narrowing, so R5-3's `isProviderId` swap is a behaviour change, not a compile fix.
- **items 1 and 5** — nothing to apply: already on this tree (`c7087e2`, `2400a0c`).
- **item 10 renumbering** — the eight `contract 1.6 item N (TUI-DESIGN-4 …)` comments become `contract 1.7 item N`
  (now at `:1219 :2241 :2288 :2295 :2317 :2373 :2385 :2561`).

`test/unit/tui/theme.test.ts:351`, `test/unit/tui/theme-palette.test.ts:865` — `'[session]': 'dim',` added to the two
total `Readonly<Record<UiLabel, …>>` literals (without them `tsc --strict` fails TS2741). The role is `labelRole`'s
`'dim'` fall-through (`src/tui/theme.ts:277–281`), which §8.1 item 2 records as a decision.

`test/unit/core/contract.test.ts` — the label array goes 6 → 7, and a `contract 1.8` describe block asserts: the header
ordering; that **no `contract 1.6 item` comment in `core/types.ts` cites a TUI-DESIGN-4 section** (so the collision
cannot recur when import lands real 1.6 items); items 1/5 arrived; and the compile-time shape of items 2, 3, 4 and 6.

**Not touched by W0:** every other file. `src/config/ui.ts:64` and `:91` still carry `contract 1.6 item 5` /
`contract 1.6 item 4` comments citing TUI-DESIGN-4 §1.3.1/§1.3.4 — the same stale numbering, in a file round 5's §9.1
gives to **no slot**. Filed in the W0 report as a one-word hunk for whoever owns `src/config/ui.ts`.
