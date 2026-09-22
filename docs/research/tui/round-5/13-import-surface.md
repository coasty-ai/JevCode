# Round-5 topic: the import surface

Scope: `docs/IMPORT-DESIGN.md` §7 rows tagged **[T]**, §5, §6 rows G/H, §4.4.3; the real facade is
`src/import/index.ts` (import **only** that module). Verified against this worktree (`r5-design`, HEAD
`d860827`, an ancestor of `main` `6d46875`) 2026-09-22. Every symbol below was grepped/read directly; no
number is copied from a design doc without a re-check. Companion reading: `00-contract-digest.md` §A3 (the
first-pass import table) — this file goes one layer deeper and adds two things the digest did not check:
`report.ts`'s redaction call, and the live contract-number ledger.

---

## 1. What the designs and code say (verified, file:line)

### 1.1 The facade — everything the TUI session is allowed to import

`src/import/index.ts` is a 699-line module whose own header states the contract: "the only module the CLI
and the TUI session import… it performs no writes" (`index.ts:1-9`). Every symbol the brief named is real and
at the line claimed:

| Symbol | Location | Shape (verified) |
| --- | --- | --- |
| `newImportId(now, seed?)` | `index.ts:160` | `imp_<ISO compact>_<6 hex>`, pure |
| `isImportId(value)` | `index.ts:167` | regex `^imp_\d{8}T\d{6}Z_[0-9a-f]{6}$` |
| `PlanImportOptions` | `index.ts:175-211` | 20 fields incl. `env`, `trust`, `decider`, `redact?`, `destState?`, `destinations?`, `cannotRead?`, `signal?` |
| `planImport(opts)` | `index.ts:331` (`async function planImport(opts: PlanImportOptions): Promise<ImportPlan>`) | phases 1–3, writes nothing (doc comment `index.ts:323-325`) |
| `probe(opts)` | `index.ts:584` | `PlanImportOptions & {deadlineMs?}` → `Promise<ImportProbe>`; default `deadlineMs: opts.deadlineMs ?? 50` (`:592`) — the wizard's ≤ 50 ms probe |
| `summarisePlan(plan)` | `index.ts:648` | → `PlanSummary { groups, toImport, toReview, skipped, bytes, credentialsFound }`; `PlanGroup`/`PlanSummary` interfaces at `:606`/`:614` |
| `applicableRows(plan, {scope})` | `index.ts:680` | excludes `review`, `suggest`, every `skip:*`, and **every `class === 'secret'` row** (`:683-686`) — confirms the brief's "never review/conflict/skip/credential rows" exactly |
| `applyPlan` / `resumeImport` / `undoImport` | re-exported `index.ts:134/142/145`, defined `apply.ts:704`ish (bodies verified present, not line-pinned here) | run phase 4 over the caller's write seam |
| `newImportId` / `isImportId` / `asImportPlan` | `:160`, `:167`, `:694` | `asImportPlan` narrows a `Json` value: requires `v===1`, `importId: string`, `Array.isArray(rows)` |
| `ImportWriteFs` | **not a named export** — reaches the caller only via `export * from './types.js'` (`index.ts:57`) | defined `types.ts:484`, extends `ImportFs` (`types.ts:469`) |
| `render(row, sourceText)` / `sourcePath(row)` | fields on `ApplyOptions`, `apply.ts:391` / `:393` | **not importable symbols** — a seam contract the caller implements, exactly as the digest already flagged |

`summarisePlan`'s grouping (`groupOf`, `index.ts:625-641`) is worth quoting because it is the one function
that decides what a `[y] import all N` keystroke actually means: `review` action → `'review'`; any
`skip:*` action → `'skipped'`; `suggest` → `'config'`; otherwise by `row.class` (`memory`→memory,
`rule`→rules, `command`→commands, `mcp`→mcp, else→config). `applicable` on a `PlanGroup` is
`key !== 'review' && key !== 'skipped'` (`index.ts:645`) — there is no separate "credential" group key at
all; a `class: 'secret'` row is filtered out of `applicableRows` by class, not by group, so a UI that only
reads `PlanGroup.applicable` per group (rather than also excluding `class==='secret'` per row) would apply a
credential if one somehow slipped into an "applicable" group. Today it can't (classify never emits a
`secret`-class row with a plain `create`/`append` action — every secret row's `action` is `skip:secret` or it
sits in the credential prompt), but the invariant lives in two places (`groupOf` and `applicableRows`) rather
than one, which is worth a defensive assertion in the TUI code, not a design fix.

### 1.2 The `redact` seam and its two verified corrections

`PlanImportOptions.redact?: (s: string) => string` (`index.ts:210`, doc comment `:200-208`) must be
`createRedactor(<configured secrets>).redact` — `createRedactor` is `src/core/redact.ts:93`, **not** in
`src/import/**`. Inside `planImport`, the option is composed as:

```ts
const exact = opts.redact !== undefined ? { redact: opts.redact } : undefined;
const redact = (s: string): string => redactSecrets(s, exact);   // index.ts:326-331
```

`redactSecrets(s, exact)` is `parse/markdown.ts:46-48`: `return redactSpans(s, detectSecrets(s, exact), PATTERN_MARKER)`.
`detectSecrets(s, exact)` (`core/redact.ts:429-438`) **always** runs `REDACTING_FAMILIES` (the 6
substring-and-replace families driving `patternRedact`, `core/redact.ts:68-86`) and `WARN_ONLY_FAMILIES`
(the remaining 9) regardless of whether `exact` is present — the `exact` branch only adds a *third* pass for
the caller's own configured secret strings. **Correction 1 (matches the digest):** passing `patternRedact`
instead of `createRedactor(secrets).redact` does not "downgrade" the nine warn-only families — they run
either way. The real, narrower cost of the substitution: an *exact* configured secret string that happens to
match none of the 15 regex families would never be substituted.

**Correction 2 (matches the digest):** the runtime Jev question key for group I is the ordinal
`secret_<i>`, built in `secretQuestionIds` (`plan.ts:1108-1122`) and consumed as `` `secret_${i}` `` in
`questions.ts:136`. `secretCandidateId(itemId, dotted)` (`plan.ts:1108`, `` `${itemId}:${dotted}` ``) is a
**separate, content-keyed** id used only as the map's lookup key (`plan.ts:1119`, `plan.ts:1145`) so the
facade's candidate list and `plan.ts`'s answer lookup can't drift (the comment at `plan.ts:1100-1106` names
this exact failure as "review defect 5" — a real bug this design already fixed). The design brief's
`secret_<candidateId>` framing conflates the two; round 5 should not build against a content-keyed runtime id.

**New finding, not in the digest — `report.ts` never applies the exact layer.** `renderReport` and
`renderPlanJson` (`report.ts:162`, `:283`) both call `redactSecrets(text)` **with no second argument**
(`report.ts:271`, `:295`) — so `report.md` and `plan.json` get only the 15 pattern families, never the
caller's `createRedactor(secrets).redact` substitution. `discover.ts:588` and `index.ts:331` (headings sent to
Jev, `sources.jsonl`) both thread `exact` through; `report.ts` does not, and neither `renderReport` nor
`renderPlanJson` takes an `exact`/`redact` parameter to thread. Concretely: a configured secret whose exact
string matches none of the 15 families (e.g. an internal token format the pattern list doesn't know) would be
absent from `sources.jsonl` and any Jev request body, but could still surface in `report.md`/`plan.json` if a
source's `display`/`why`/`warnings`/`notices` field happened to echo it verbatim (unlikely given those fields
are engine-derived strings, not raw file content — but the asymmetry between the two call sites is real and
worth a decision, not an assumption). See §5.5 and §6 open question.

### 1.3 What is genuinely unbuilt (verified NOT FOUND)

| Design item | Verified state |
| --- | --- |
| `Command` union (`args.ts:19`) | `'chat'\|'run'\|'config'\|'bench'\|'perf'\|'login'\|'logout'\|'sessions'\|'report'\|'why'\|'calibration'\|'completion'\|'upgrade'` — **no `'import'`** |
| `src/cli/import.ts` | does not exist |
| `COMMANDS` (`registry.ts:102-555`) | 62 `name:` occurrences total incl. `ArgSpec`s; the array itself has 37 rows per the digest's count — **no `import`/`memory` row**; `POPULAR` (`registry.ts:86`, 16 entries) unchanged, matching the design's "not displacing a popular row" claim |
| `WizardStep` (`onboarding/reducer.ts:26`) | `'detect'\|'key'\|'options'\|'jevProvider'\|'provider'\|'generatorKey'\|'jevKey'\|'save'\|'verify'\|'trust'\|'sandbox'\|'done'\|'exit'` — 13 members, **no `'import'`** |
| `OverlayKind` (`layout.ts:52`) | `'none'\|'review'\|'wizard'\|'followup'\|'secret'\|'blocking'\|'palette'\|'undo'\|'exitConfirm'\|'intake'` — **no `'import'`** |
| `COLLAPSING` (`layout.ts:58`) | 5 members (`review, followup, blocking, exitConfirm, intake`) — **no `'import'`** |
| `OverlayData` (`Overlay.tsx:66-77`) | 8 optional members (`review, wizard, followup, secret, blocking, palette, undo, mention, intake`) — **no `import?`** |
| `INDEX_KINDS` (`session/index.ts:36`) | `['run:start','run:end','rename','steer','undo','pause','budget','chat']` — 8 kinds, **no `'import'`** |
| `SettingName` (`config/types.ts:6-`) / `SETTINGS` (`defaults.ts`) | no `import.*` or `memory.*` rows; `seenDefaultMode`/`ui.history` are the closest analogues (see §1.4) |
| `FactKey` (`chat/facts.ts:17`) | 14 members (`what_it_is`…`provider`) — **no `memory`** fact |
| `loadMemory(...)` | not found; only `loadInstructions(workspaceRoot, gitRoot, home, opts?)` exists (`config/instructions.ts:158`) |
| `probeTrustInputs` | exists (`config/trust.ts:238`) but its signature is `(workspace, root, agents, agentsName, changed?)` — **no `memory` parameter yet**, confirming the design's W3 item 35 is additive, not yet landed |

This is a completely greenfield surface: every TUI/CLI-side file the design names is absent, and the harness
side (`src/import/**`, 4 474 LOC across `index.ts`/`plan.ts`/`apply.ts`/`types.ts`/`questions.ts`) is
substantially built and already carries three post-review hardening passes visible in the source comments
("review defect 5/6(b)/7/9", `plan.ts:1100`, `index.ts:265`, `types.ts:479-485`, `report.ts:265-268`) — i.e.
the engine has already been through an adversarial review cycle the TUI side has not yet had a chance to be
subjected to.

### 1.4 Reusable idioms already on `main`, ready for the six new settings and two commands

- `CommandCategory` (`registry.ts:44`) already has a `'config'` member — the design's category assignment for
  `import`/`memory` (§5.8.1) needs no type change.
- The idle-only error string is a **template**, not a literal to add: `registry.ts:600`
  `` `error: /${spec.name} runs when the run is idle; Esc pauses first` `` (also `dispatch.ts:279` for
  `--flag`s). Setting `import`'s `availableDuringTask: 'idle'` produces
  `error: /import runs when the run is idle; Esc pauses first` for free — nothing to hand-write.
- `negateEnv` idiom for `memory.enabled` / `--no-memory`: `defaults.ts:168`'s `ui.history` row is the existing
  pattern (`boolFlag: {key:'noHistory', negate:true}`, `negateEnv: ['JEVCODE_NO_HISTORY']`).
- `hidden: true` + one-time-write idiom for `seen.import`: `defaults.ts:154`'s `seen.defaultMode` row is the
  exact precedent the design cites, and it is real.
- `writeConfigValue(fileKey, value, opts)` (`credentials.ts:328`) is the function `2`/`3`/`Esc` in the wizard
  step would call to persist `seen.import`.
- `CREDENTIAL_KEYS = ['apiKey', 'jevApiKey']` (`credentials.ts:26`) confirmed — only these two are ever
  offered by the credential prompt.
- `BY_NAME` alias map (`registry.ts:557-563`) is a flat `Map` built once from `name` + every `alias`; adding
  `import`/`imp` and `memory`/`mem` is a two-row append, no structural change.

### 1.5 Round-4 dependency (contract numbering, block grammar, the shared file)

The contract-number ledger in `main`'s `docs/DECISIONS.md:1035-1043` ("Contract blocks are numbered by
assignment…") is authoritative and, as of commit `aa7dc3c` on `main` (2026-09-22, *after* this worktree
branched), reads: **1.4 coordination, 1.5 orchestration, 1.6 import, 1.7 TUI round 4, 1.8 TUI round 5, 1.9
Fastlane (HARNESS-NEXT)**. This worktree's own copy of `docs/DECISIONS.md:1037` still stops at "1.7 TUI round
4" — it predates that assignment. Nothing here blocks import work (`1.6` was reserved for import before this
worktree branched and is unchanged), but round 5's own design doc should cite `1.8` for itself, not "1.5" as
the task brief's own phrasing loosely suggested, and should note the `DECISIONS.md` entry needs a merge-time
sync. `src/core/types.ts:9-14` confirms the landed sequence in code today: `1.1, 1.2, 1.2, 1.3, 1.4, 1.7` — 1.5
and 1.6 are reserved-but-unlanded, exactly as `00-contract-digest.md` §A2 found.

TUI-DESIGN-4 §8 item 1 adds `TranscriptItem.detailRows?`/`detailKind?` and §3.1's `BlockRow`/`renderBlock`/
`blockWidth` grammar (D-U, `TUI-DESIGN-4.md:2889-2962`, ratified §0.1). IMPORT-DESIGN §5.2/§5.5 was written
*before* that grammar existed and mocks the overlay and the `[import]` items as pre-formatted string blocks
(`Import — 41 to import · 9 to review …`). Round 5 has to decide whether the import overlay's group-row table
and the `[import]` report items are built as `BlockRow[]` (`kv`/`facts`/`table`/`note` kinds) through
`block()` — the round-4-mandated single grammar for "clean, detailed, nicely separated" command output that
is this whole round's user-facing goal — or as their own bespoke renderer. See §5.1.

---

## 2. What the best tools do (cited)

No peer tool in this space runs a **discover → classify → dry-run plan → review → apply** pipeline with a
persisted plan id, resumable apply and an undo command. The comparable surfaces are narrower:

- **opencode** does not "import" another tool's memory at all — it reads the other tool's own file **in
  place**, as a fallback when its own file is absent: "Project rules use `CLAUDE.md` (if no `AGENTS.md`
  exists)" and "Global rules use `~/.claude/CLAUDE.md` (if no `~/.config/opencode/AGENTS.md` exists)"
  ([OpenCode Rules](https://opencode.ai/docs/rules/)). There is no copy, no review UI, no manifest — the
  source file becomes the memory file by virtue of a name-resolution order. `/init` is the closest thing to a
  wizard: it "scans the repository, asks targeted questions… and generates concise guidance," and "if an
  `AGENTS.md` already exists, the command improves it in place instead of clobbering it" (same page, and
  [The Prompt Shelf's opencode guide](https://thepromptshelf.dev/blog/opencode-agents-md-guide-2026/)). This
  is the one real design alternative worth naming in §5: a **live-fallback** mode that needs zero review UI,
  at the cost of never normalising formats or redacting anything, and of reading a file that could contain a
  secret nobody classified.
- **Claude Code**'s own memory surface is a single slash command, `/memory`, which "opens your CLAUDE.md
  memory files for editing… lists your memory file locations, including CLAUDE.md and CLAUDE.local.md" — a
  direct editor, not an importer
  ([Claude Code cheatsheet](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet); the
  quick-add `#` shortcut existed briefly and was discontinued by the time of this research per
  [DEV Community's writeup](https://dev.to/aicoding-guide/does-add-to-claudemd-in-claude-code-what-the-current-docs-say-5325)).
  JevCode's own `/memory` (design §5.8.2) is closer to this — `list`/`show`/`add`/`forget`/`reload` — and the
  naming collision with Claude Code's command is intentional and low-risk (same verb, same rough job).
- **Cursor** migrated away from a single `.cursorrules` file to `.cursor/rules/*.mdc`, and separately now
  reads `AGENTS.md` natively, "including nested files in subdirectories, with more specific paths taking
  precedence" — but there is no in-product migration tool; the guidance is a manual rewrite
  ([Cursor rules 2026 guide](https://www.vibecodingacademy.ai/blog/cursor-rules-complete-guide),
  [AGENTS.md vs .cursorrules vs Claude Skills](https://blog.buildbetter.ai/agents-md-vs-cursorrules-vs-claude-skills-2026-comparison/)).
  This confirms the "one canonical destination format, several source dialects" shape of the problem is real
  industry-wide, but every other tool either reads the foreign format directly (opencode, Cursor's AGENTS.md
  support) or asks the human to hand-migrate (Cursor's own rules guides) — nobody else built a reviewable ETL
  step.
- **Codex CLI** keeps `AGENTS.md` for standing instructions and a separate `~/.codex/memories/` directory
  written by background session summarisation, gated by two independent on/off switches — one for writing new
  memories, one for reading existing ones into context
  ([Codex CLI Memory deep dive](https://mer.vin/2025/12/openai-codex-cli-memory-deep-dive/),
  [Advanced Configuration](https://developers.openai.com/codex/config-advanced)). The read/write split as two
  settings (rather than one `memory.enabled`) is worth naming in §5 as an alternative to the design's single
  `memory.enabled` row (§5.9) — JevCode's importer only *writes* memory once (at apply time) and *reads* it
  every run, so the two-switch shape doesn't obviously apply, but it is the sharpest documented precedent for
  splitting a memory feature's on/off surface in two rather than one.

**Bottom line for §5:** JevCode's design (copy-with-review, a persisted plan, resumable apply, undo) is more
thorough than anything shipped by the four peers, at the cost of being the only one of the five that needs a
dry-run report, an overlay, a CLI twin and a wizard step at all — the peers' simplicity comes from either
reading the foreign file directly (no copy, no redaction, no review) or doing nothing automatic (manual
migration). This is a reason to keep the "groups-first, one key" overlay (§5.2 [G2.5]) as tight as designed,
not a reason to add scope.

---

## 3. Edge cases

Ninety-seven rows are already enumerated in `IMPORT-DESIGN.md` §6 (Discovery 18, Reading 13, Imports/refs 6,
Classification 16, Plan 11, Apply 17, Surfaces 11, Live-session 5); re-litigating all 97 here would not add
information. What follows is what §1's code-reading adds or sharpens for the **[T]**-tagged rows specifically
— the ones that land on the TUI session's own files.

1. **Row 70 (partially migrated, manifest `v: 0`) [T]** — the design says the reader "upgrades `v: 0` in
   memory… never rewrites it until the next successful apply." `src/config/imports.ts` does not exist yet
   (§1.3), so this tolerant-reader behaviour is 100% new code with no existing analogue to reuse; the nearest
   precedent in the repo is the manifest-shape pattern of `config/credentials.ts`'s own tolerant JSON reads,
   worth reusing structurally rather than writing a bespoke upgrade path.
2. **Row 78/79 (idle-only apply, EACCES mid-apply) [T]** — both now confirmed free: row 78's exact string is
   auto-generated (§1.4); row 79's `[import] error: could not write … : EACCES (40 of 41 applied)` has no
   existing template to reuse and must be hand-built in `config/imports.ts`'s item builders (design §5.5).
3. **Row 80 (trust re-pin) [T]** — depends on `probeTrustInputs` gaining a `memory` parameter (§1.3, not yet
   landed) *and* a new `repinAfterApply` reconstruction function neither of which exists on `main` today; this
   is the one [T] row with a real code dependency on a [H] file (`config/trust.ts`) that has zero scaffolding
   for it yet, unlike most of the other [T] rows which are additive to files that already have room for them.
4. **Row 86/87/88/89/90/91 (the five twins + `--mock`) [T]** — all route through `src/tui/import/lines.ts`,
   which does not exist. Because `Overlay.tsx`'s existing twins (`--plain`, `--screen-reader`, `--ascii`) are
   all driven by one `lines()`-per-surface convention already used by every other overlay
   (`onboarding/lines.ts`, `chat/lines.ts`, etc.), the risk is not "will the twins exist" but "will `import`'s
   `lines.ts` accidentally duplicate a glyph/ASCII mapping instead of importing `glyphs.ts:223`'s
   `asciiTwins`" — worth a lint/test the same shape as the existing twin-parity tests for other overlays.
5. **`report.ts`'s missing exact-redaction layer (new, not in IMPORT-DESIGN §6 at all)** — see §1.2. This is
   a genuine gap in the *harness* file (`[H]`), not a TUI row, but the TUI session is the one that will notice
   it first: `jevcode import --json` and `--plain`'s full report both render through `report.ts`, and neither
   currently receives the configured-secret exact layer. Round 5 should either (a) treat this as accepted
   behaviour (the 15 pattern families are the report's redaction contract; the exact layer is Jev-request-only
   and `sources.jsonl`-only) and document it as such in `docs/IMPORT.md`, or (b) file it back to the harness
   slot as a real gap and thread `redact?`/`exact?` through `renderReport`/`renderPlanJson`. Recommendation in
   §5.5.
6. **Row 92 (resize during the overlay) [T]** — this is the one row that depends on TUI-DESIGN-4's own W1
   deliverables (`fitRung`, `gutter.ts`'s `gutterMode`) landing first, since the import overlay's five-row
   default view and its narrow twin need the same rung ladder every other round-4 overlay now uses (§1.5).
   Building the import overlay against a bespoke width calculation instead of `fitRung` would be the one way
   this surface diverges from round 4's own stated goal of "one command-output grammar."
7. **The `[project]` palette tag collision surface (design §5.8.3, not in §6 at all)** — `resolveCommand`
   consults `findCommand` first, so a project command literally named `import` or `memory` (a
   `.jevcode/commands/import.md`) would silently never be reachable by name, only by its future `[project]`
   tag if the palette ever lists shadowed rows. `registry.test.ts`/`project.test.ts` (design's own named
   tests) need a case for this specific shadowing, not just generic collision.

---

## 4. Pinned strings and twins

All of §5.1–§5.8's strings in `IMPORT-DESIGN.md` are final copy per its own header ("Every string below is
final copy," `IMPORT-DESIGN.md:1416-1419`) and none of them exist in code yet (§1.3), so there is nothing to
reconcile against a stale implementation — round 5's job is to land them as written, through one file
(`src/tui/import/lines.ts`, design's own placement) with the five twins the file already commits to:
`--plain` (numbered, `Enter selection (1-N):`), `--screen-reader` (numbered, no bullets, counts as words),
`--ascii` (the `glyphs.ts:223` `asciiTwins` map, code-generated strings only, never user text), pipe/
`--no-input` (dry run only, one summary line), `--json` (one `ImportPlan`, no prose). Two things worth
flagging before they are pinned:

- **`[import]` items belong in `src/config/imports.ts`, re-exported by `src/tui/import/lines.ts`** (design
  §5.1, §5.5) — this is the same split `credentials.ts`'s item builders already use (`keyEnteredText`,
  `savedText` at `credentials.ts:36,45`, cited directly by the design's §5.4 credential-prompt text). Building
  the 17 `[import]` strings as a second copy inside `lines.ts` instead of importing them from `imports.ts`
  would be the kind of drift TUI-DESIGN-4's D-V pin-inventory discipline (§3.7) exists to prevent; round 5
  should adopt the same "glyph-agnostic named anchor, self-tested against two glyph sets" pattern D-V ratified
  for round 4's engine-item text (`TUI-DESIGN-4.md:2895`, `§0.1` row D-V) for these 17 strings too, since they
  are exactly the same kind of pinned, test-critical prose.
- **The overlay's default view (§5.2) is five rows and one key** — `[y] import all N` — and depends on
  `summarisePlan`'s `PlanGroup[]` (§1.1) matching the five named groups (`memory`, `rules`, `commands`, `mcp`,
  `review`) exactly. `groupOf`'s `switch` (`index.ts:625-638`) already produces exactly these five plus
  `skipped` (six total, `skipped` hidden from the default view per design). No new engine work needed; this is
  purely a TUI-side rendering exercise against an already-shaped `PlanSummary`.

---

## 5. Recommended decisions with options and a recommendation

### 5.1 Should the import overlay/report use round 4's `BlockRow` grammar or its own renderer?

- **Option A — bespoke renderer.** Build `src/tui/import/lines.ts` and `Report.tsx` exactly as
  `IMPORT-DESIGN.md` §5.2/§5.5 mock them: hand-formatted string rows, no dependency on round 4's `block/**`.
  Fastest to land; ships even if round 4's `block/**` slips.
- **Option B — `BlockRow`-native.** Model the overlay's group table and the `[import]` summary items as
  `BlockRow[]` (`kv`/`table`/`note` kinds) rendered through `renderBlock`/`blockWidth`
  (`TUI-DESIGN-4.md §8 item 1, §3.1`), so `/import`'s output looks and measures exactly like `/config`,
  `/cost`, `/diff` once round 4 lands. Blocks on round 4's W0/W1 (`block/lines.ts`, `fit.ts`, `gutter.ts`).
- **Recommendation: B**, gated on round 4 landing first — which the task brief's own repo rules already
  assume ("ROUND 4 lands BEFORE round 5 is implemented"). The user's round-4 request that motivated D-U
  ("the output of the commands look super clean… nice separated") applies with equal force to a 41-row import
  report; building a second, parallel string-formatting convention for one command family the same week round
  4 unifies the other 24 call sites onto one grammar would be the exact kind of drift D-U's commit was written
  to prevent. Cost: `src/tui/import/lines.ts` cannot be finished until `block/lines.ts` (round 4 W1) exists,
  which the design's own W2 dependency note already anticipates ("W2 [T] builds the whole overlay against a
  hand-written `plan.json` fixture before W2 [H] exists" — the same wave-ordering trick works for round 4's
  `block/**`: stub it, build against the stub, swap in the real module when it lands).

### 5.2 Two commands (`import`, `memory`) vs. widening `/sessions`-style existing commands

- **Option A — two new top-level commands**, as designed. `import`/`imp` and `memory`/`mem`, both `category:
  'config'`, both reusing the idle-error template (§1.4). Registry goes from 37 → 41 (round 4) → 43 (round 5).
- **Option B — fold under `/config`**. `/config import …` / `/config memory …` as sub-verbs, avoiding two new
  top-level names.
- **Recommendation: A.** The registry's own `sessionsOp`-style idiom (`ParsedFlags.importOp?`) already
  precedent-matches a dedicated verb family (`jevcode sessions list|reindex|prune|unlock`,
  `00-contract-digest.md` A1 row `/sessions`), and `/memory` intentionally mirrors Claude Code's own `/memory`
  verb (§2) — folding it under `/config` would break that intentional naming parity for no measured benefit.
  `POPULAR` stays unchanged either way (§1.3), so top-level-ness costs nothing in palette real estate.

### 5.3 `memory.enabled` as one switch vs. Codex's two (read/write split)

- **Option A — one switch**, as designed (`memory.enabled`, default `true`, `--no-memory` negates).
- **Option B — two switches**, mirroring Codex CLI's read/write split (§2), e.g. `memory.write` (import may
  apply memory rows) and `memory.read` (the engine loads memory into the prompt).
- **Recommendation: A.** Codex's split exists because its memory is **written continuously** by background
  session summarisation, so "stop writing but keep reading" and "read nothing while debugging, still record
  the session" are both real operator needs. JevCode's memory is written **once**, at `import apply` time
  (and again only via `/memory add`/`reload`), never by the engine itself during a run — there is no
  continuous-write process to gate separately from continuous-read. Keep the one-switch design; note Codex's
  precedent in `docs/IMPORT.md` as the reasoning trail so a future "should memory auto-summarise a session"
  feature (which *would* need the two-switch shape) does not have to rediscover it.

### 5.4 The `secret_<i>` / `secretCandidateId` naming gap (§1.2) — fix now or document now?

- **Option A — rename nothing.** Keep the ordinal `secret_<i>` as the runtime Jev question key; document the
  distinction (content-keyed lookup vs. ordinal wire id) in `docs/IMPORT.md` so nobody reproposes "fixing" it
  under the mistaken belief it is a bug.
- **Option B — make the runtime id content-keyed**, matching `sameMeaningId`/`rankId`/`contradictsId`'s
  pattern (all three are content-keyed per `plan.ts:581-587`), for consistency.
- **Recommendation: A.** `secretQuestionIds` (`plan.ts:1108-1122`) exists specifically to prevent a
  **counter-restart bug that could demote a real credential** (the "review defect 5" comment, §1.2) — an
  ordinal that increments once across the whole candidate list, never per-file. A content-keyed id would not
  change that safety property (the map would just have different keys), so option B is pure churn with no
  behavioural upside and a re-test cost across `questions.ts`, `plan.ts`, and every fixture that hard-codes
  `secret_0`, `secret_1`, etc. This closes `00-contract-digest.md`'s open question 4 with a concrete answer
  rather than leaving it for the peer.

### 5.5 The `report.ts` exact-redaction gap (§1.2, §3 item 5)

- **Option A — accept as documented.** State in `docs/IMPORT.md` that `report.md`/`plan.json` redact the 15
  pattern families only, and that the exact-secret substitution is a Jev-request/`sources.jsonl`-only
  guarantee. Zero code change.
- **Option B — thread `redact?`/`exact?` through `renderReport`/`renderPlanJson`.** Requires a harness-side
  change to `report.ts` (an `[H]`-owned file per §7's owner split) plus updating every call site
  (`index.ts` doesn't currently pass anything to `report.ts` at all — confirm whether `report.ts` is even
  invoked from `index.ts` or only from `cli/import.ts`, which does not exist yet, before committing to this).
- **Recommendation: B, filed as a request to the harness slot, not built by the TUI session.** `report.ts` is
  `[H]`-owned (§1.5, `IMPORT-DESIGN.md §7` owner table). The asymmetry is real (§1.2) even if the practical
  exposure today is narrow (engine-derived strings, not raw source bytes), and "the report is what `--plain`
  prints and what a human reads to decide whether to `y`" makes it the wrong place to under-redact relative to
  what a Jev request already gets. This should be one line in round 5's shared-file request list to whichever
  slot lands `report.ts`'s remaining work, not a silent TUI-side workaround (there is no TUI-side workaround
  available — `renderReport`'s signature has no seam to inject `exact` today).

### 5.6 Wizard-step placement: probe timing

The design already pins this precisely (`WizardStep += 'import'` between `'sandbox'` and `'done'`, gated on a
≤ 50 ms probe run "after the first frame… and after the sandbox step," design §5.1) and `probe()`'s default
`deadlineMs: 50` (§1.1) matches. No decision needed here — flagging only that `WizardStep`'s 13 current
members (§1.3) put `'sandbox'` and `'done'` adjacent already (verify at merge time that no other round-5-
adjacent design also wants to insert a step between them, which would make two slots edit the same enum
line — the six-slot digest's shared-file convention (§9.2-style) should cover this the same way it covers
`registry.ts`).

---

## 6. Open questions

1. **Does the harness slot accept the `report.ts` exact-redaction request (§5.5)?** This is new since the
   digest — neither `00-contract-digest.md` nor `IMPORT-DESIGN.md` §6's 97 rows name it. It needs an answer
   before `docs/IMPORT.md` can state a redaction guarantee for `report.md`/`plan.json` that is actually true.
2. **Is `PlanSummary`'s two-layer credential exclusion (group `applicable` flag + `applicableRows`'s
   per-row `class==='secret'` check, §1.1) intentional defense-in-depth, or should `applicableRows` be the
   *only* place that decision lives, with the overlay reading `applicableRows`'s output directly rather than
   re-deriving "which groups does `y` apply" from `PlanGroup.applicable`?** Building the overlay to trust
   `PlanGroup.applicable` per group, rather than intersecting with `applicableRows` per row, is the more
   natural Ink implementation and it is currently *safe* only because no code path produces an "applicable"
   secret row today — worth a one-line confirmation from the harness slot that this is a structural invariant
   (a `secret`-class row can never have a non-`skip`/non-`review` action), not merely a current fact.
3. **`docs/DECISIONS.md`'s contract-number ledger (§1.5) has moved on `main` since this worktree branched** —
   is a rebase/sync of that one entry ("1.8 TUI round 5, 1.9 Fastlane") expected before round 5's own design
   doc is drafted, or does round 5 just cite `1.8` directly and let the doc sync happen at merge time the way
   `IMPORT-DESIGN.md §7.1` already plans for (`IMPORT_LIMITS` shipping as an additive-only stub if coordination
   slips)?
4. **Is the `--mock`/no-Jev fallback path (design §4.9, row 91) expected to produce byte-identical plans
   across runs for the same fixture corpus**, i.e. is there a golden-plan snapshot test planned, given the
   engine side (`questions.ts`, `plan.ts`) is already built and the TUI side (`import.ts`, the overlay) will
   need a stable fixture to build against per the design's own W2 dependency note (§7.7)? If not, the TUI
   slot's W2 work (building the overlay against "a hand-written `plan.json` fixture") has no canonical source
   for that fixture and each contributor may hand-write a different one.
5. **Should `/memory reload`'s live-run pin (row 94, "the matched rule/topic set is pinned at run start")
   also cover a `/import apply` that runs mid-session (dry-run only per the design, since apply is
   idle-only)** — confirm the idle-only gate on apply makes this row moot for `import` specifically (apply can
   never race a live run's prompt build because it cannot run while live at all), so the pin logic in
   `EngineOptions.memory` only ever needs to worry about `/memory reload`, not `/import`.

---

*Verification method: direct reads of `src/import/{index,plan,apply,types,questions,report}.ts`,
`src/core/redact.ts`, `src/tui/{layout,Overlay}.tsx`, `src/tui/commands/registry.ts`,
`src/tui/onboarding/reducer.ts`, `src/session/index.ts`, `src/config/{types,defaults,trust,credentials,
instructions}.ts`, `src/chat/facts.ts`, `src/cli/args.ts`, `src/cli/tui-prompter.ts`, `src/core/types.ts`, and
both `docs/DECISIONS.md` copies (this worktree and `main`'s), against this worktree at HEAD `d860827` and,
read-only, `main`'s working copy for the contract-ledger check in §1.5. `docs/TUI-DESIGN-4.md` §0, §8, §9,
§12 and `docs/IMPORT-DESIGN.md` §4.4.3, §5, §6 (rows G/H), §7 were read in full. Four web sources cited in
§2. No file outside this one was written; no git state was changed.*
