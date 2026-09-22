# JevCode import design — bring every memory and workflow you already have, with a dry run you can read

Written **2026-09-21** against HEAD `5a167b2`. Every `file:line` below was read at that HEAD; every measured
number in §3.12 and §8.5 was taken on the author's machine on that date (read-only; no key and no memory body
was printed or copied anywhere).

**Spine.** The winner of the round's judgement — *`jevcode import` — one command, a dry-run report, and
interactive resolution* (7.2/10 and 7.5/10 across two independent judgements, sole design under judgement in
both). Four phases: **discover → classify → plan → apply**. The first three write nothing outside
`~/.jevcode/imports/<id>/` and produce one reviewable artefact, the **dry-run report**; phase 4 applies exactly
the rows the human approved, through markered, sha256-pinned, resumable, undoable writes recorded in an
idempotency manifest.

**Grafts.** Both judgements asked for changes; all fourteen are applied and marked inline as **[G1.1]…[G1.6]**
(judgement 1) and **[G2.1]…[G2.8]** (judgement 2). Appendix E is the ledger: graft → section → test. Nothing
else in the spine was altered except where a graft or a re-read of the tree forced it; §9.7 lists the eight
places where the spine's own citations were wrong and what the tree actually says.

**Cross-references.** `D §n` = `docs/DESIGN.md`; `TD §n` = `docs/TUI-DESIGN.md`; `TD2 §n` = `docs/TUI-DESIGN-2.md`;
`TD3 §n` = `docs/TUI-DESIGN-3.md`; `CD §n` = `docs/COORDINATION-DESIGN.md`. `A<n>` / `D-<x>` / `F<n>` are the
existing design's item, decision and invariant ids.

**Read order.** §1 (what "works perfectly" means, as gates) → §2 (the destination, because there is no
importer without one) → §4 (the engine) → your owner's rows in §7 → the sections they name. §3 and §6 are
reference tables; skim and come back.

---

## §0 Notation, and the one-sentence contract

**Contract.** `src/import/**` is a pure-plus-read-only module that turns the filesystem into an `ImportPlan`
and renders it. **It performs no writes.** Every write goes through a seam the TUI session supplies:
`src/cli/import.ts` for workspace files (via `src/core/atomic.ts writeFileAtomic`, `atomic.ts:19`),
`src/config/imports.ts` for `~/.config/jevcode/**`, `src/config/credentials.ts writeCredentials`
(`credentials.ts:268`) for credentials, `src/config/trust.ts` for the re-pin. The harness can therefore land
the whole engine without touching a file JevCode owns.

| Symbol | Meaning |
| --- | --- |
| **[H]** | owned by the harness slot |
| **[T]** | owned by the TUI session slot |
| **[G1.n]** / **[G2.n]** | a graft from judgement 1 / judgement 2, applied here |
| **M / W / C / S / T / X** | classification: **M**emory, **W**orkflow, **C**onfig, **S**ecret, **T**ranscript, skipped (**X**) |
| `band` | the interval of a code rule's confidence inside which — and only inside which — Jev is consulted |
| `p` | a Jev probability (Noul) or the code rule's own confidence, as marked |
| `imp_<id>` | an import id: `imp_<ISO compact>_<6 hex>`, e.g. `imp_20260921T120000Z_a1b2c3` |

**The ten principles** the rest of the document is an expansion of:

1. **Read-only until the human says otherwise.** Phases 1–3 open files for reading only. Approval is the
   human's own TUI/TTY confirmation or an explicit `--yes` on their own command line; an agent-, hook- or
   script-supplied "approval" is never authority, and `--yes` may never confirm a credential row (§4.8.2).
2. **Code decides; Jev disambiguates inside a declared band.** Every classification has a *total* code rule.
   Each rule publishes an abstention band. Jev is asked only for items inside it, so Jev cannot overturn a
   confident code verdict.
3. **Jev sees shapes, not content.** A request carries paths, byte counts, sha256 prefixes, frontmatter *keys*,
   heading *texts* (redacted, clipped), charset/entropy *buckets* and similarity scores — never a file body,
   never a candidate secret's bytes. `--jev-sample` is the only knob that widens this.
4. **The conservative side on abstention.** Jev unreachable / 401 / 402 / 429 / timeout / `--no-jev` / `--mock`
   ⇒ the code fallback's *safe* answer: unknown value → secret; unknown file → skip; uncertain duplicate →
   keep both; uncertain conflict → review. Never the permissive side.
5. **Per-key, not per-file, classification.** `~/.claude/settings.json` on this machine is simultaneously
   WORKFLOW (`hooks`), CONFIG (`permissions`, `model`, `effortLevel`) and SECRET (`env.ANTHROPIC_API_KEY`). One
   file yields many rows with different classes.
6. **Provenance on every byte.** Every written file carries `source: {tool, path, sha256, imported, importId}`
   in frontmatter; every append is wrapped in a marker pair. Format drift is survived by keeping the pin, not
   a copy.
7. **Scope is meaning.** user / project / project-local / path-scoped are preserved as *different
   destinations*. Nothing is flattened into one `AGENTS.md`.
8. **Inert on arrival.** Executable segments are fenced; hooks and `.js` workflows are report-only; MCP
   servers are written `enabled: false`; permission grants are never written.
9. **One artefact, one lock, one manifest.** The report *is* the plan; the lock serialises every mutating
   operation **[G1.4]**; the manifest makes re-runs a no-op.
10. **`src/config` never imports `src/tui`.** `[import]` item strings live in `src/config/imports.ts` and are
    re-exported by `src/tui/import/lines.ts`, exactly as `credentials.ts:36-58` does for `[setup]`.

---

## §1 Goals, as testable properties

Each row is a property, its gate, and the file the gate lives in. "Works perfectly" means all sixteen hold on
the fixture corpora of §8 **and** on the author's real machine (§8.6, one live paid run).

| # | Property | Gate | Test |
| --- | --- | --- | --- |
| 1 | **One command.** `jevcode import` with no arguments, on a machine with any mix of the nine tools, produces a complete report and **writes only under `~/.jevcode/imports/<id>/`** **[G2.6]** | the set of paths created during a dry run, diffed against a snapshot of the fixture `$HOME`, is exactly `{~/.jevcode/imports/<id>/{report.md,plan.json,sources.jsonl}}` | `import-dryrun-writes-only-artifacts.test.ts` |
| 2 | **Nothing is silently lost.** Every discovered artefact appears in the report with exactly one action; there is no "other" bucket | `sum(rows grouped by action) === discovered.length` on a 190-artefact fixture, and every `ImportAction` value appears in at least one fixture row | `plan-total.test.ts` |
| 3 | **Nothing executes.** No imported byte can cause a command to run | fixture with `` !`touch /tmp/pwned` ``, a ```` ```! ```` block, `!{git log}`, `$(whoami)`, a `hooks` block, a `.js` workflow and an MCP `command`: after apply `/tmp/pwned` does not exist, the destinations contain ```` ```text (not run) ```` fences, `mcp.json` has `enabled: false` | `import-no-exec.test.ts` |
| 4 | **No secret leaves its file.** | grep `report.md`, `plan.json`, `sources.jsonl`, `apply.jsonl`, `~/.jevcode/sessions/index.jsonl`, `~/.jevcode/history.jsonl`, every destination file and every captured Jev request body for the fixture secrets and for all **15** `REDACTING_FAMILIES` + `WARN_ONLY_FAMILIES` patterns (`redact.ts:224-234` = 6, `:278-296` = 9) **[G2.3]** → zero hits | `import-leak.test.ts` |
| 5 | **Jev is optional and cheap.** `--no-jev`, `--mock`, 401, 402, 429 and a timeout all produce a *complete* plan | ≤ 3 Jev requests, ≤ 400 questions, ≤ `import.jevMaxUsd` (default `$0.01`); the Jev-off plan differs from the Jev-on plan only in rows a band touched, and never on the unsafe side | `import-jev-parity.test.ts` |
| 6 | **Idempotent.** A second run writes 0 bytes | every row `skip:unchanged`; `apply.jsonl` gains no line; the manifest's `lastRun` is the only change, in its own file | `import-twice.test.ts` |
| 7 | **The plan is what gets applied.** A source edited between the report and `y` is **not** written **[G1.1]** | mutate a fixture source after `plan.json`; that row becomes `review — source changed since the plan`, 0 bytes written for it, the other rows apply, exit 2 | `import-source-toctou.test.ts` |
| 8 | **Destinations are confined.** No source-controlled name can write outside the destination tree **[G1.2]** | `name: ../../.git/hooks/pre-commit`, a filename containing `..`, a 400-char unicode name, a name that normalises to empty, and a symlinked destination: all five confined; `.git/hooks` untouched | `import-slug-escape.test.ts` |
| 9 | **Undoable.** `jevcode import --undo <id>` restores byte-identical pre-images | sha256 and mode of every destination equal the `pre/` snapshot; a destination modified since the import is left alone and reported | `import-undo.test.ts` |
| 10 | **Resumable.** SIGKILL mid-apply leaves every destination either its pre-image or its final bytes | `--resume <id>` completes; no row is applied twice | `import-resume.test.ts` |
| 11 | **Preserves scope.** A Cursor `globs:`, a Claude `paths:`, a Windsurf `trigger: glob` and a Copilot `applyTo` rule all land path-scoped, never always-on | the four destinations carry `trigger: paths` and the expanded globs; none is appended to `AGENTS.md` | `plan-scope.test.ts` |
| 12 | **Cross-tool identity.** One `AGENTS.md` realpath found by five detectors is imported **once** | one `PlanRow`, `source.tools.length === 5` | `discover-dedupe.test.ts` |
| 13 | **Every prompt has five twins.** `--plain`, `--screen-reader`, `--ascii`, pipe/`--no-input`, `--json` | the same strings from `src/tui/import/lines.ts` in every twin; `--json` emits one object, no prose, no ANSI | `lines.test.ts` + 5 pty `.steps` |
| 14 | **Fast.** Discover ≤ 1.5 s p95 on the author's real shape (12 Claude project slugs, 9,911 files / 10,220 entries under `~/.claude/projects`, 3,371 transcripts totalling 2.7 GB, 25 worktrees under `JevCode/.claude/worktrees`); the wizard probe ≤ 50 ms; the first frame unaffected (F1) | `perf/import.ts` rows | `perf` gate |
| 15 | **The plan phase is bounded too** **[G1.6]** | at the declared ceiling (`planRows: 2_000`) the dedupe pass stays ≤ 400 ms p95 and never exceeds `dedupePairs: 20_000` comparisons | `perf/import.ts` row 3 |
| 16 | **Authority never widens.** Nothing imported grants a permission, installs a hook, enables an MCP server or changes the sandbox | after apply: `permissions`-class bytes written = 0; `hooks` bytes = 0; every `mcp.json` server `enabled === false`; the seatbelt profile is byte-identical except the three new write denies of §2.11 | `import-authority.test.ts` |

**Non-goals.** Importing chat *transcripts* as memory (metadata only, §4.2.6); importing another tool's
permission decisions (§4.8.4); running another tool's hooks or `.js` workflows (§3.2, class X); a two-way sync
(import is one-directional and idempotent, not a mirror); importing Cursor **User Rules** or Windsurf
**Cascade memories** from disk (they are not on disk in a documented form — §3.11 gives them a paste route).

---

## §2 The JevCode memory / workflow model — the destination

An importer with no destination is a file copier. This section defines the four shapes JevCode does not have
yet. **All four are additive: a session with none of them behaves exactly as it does today.**

### 2.1 What exists today (verified at `5a167b2`)

`src/config/instructions.ts` is the whole of JevCode's persistent memory:

- the first `AGENTS.md` (fallback `CLAUDE.md`, `INSTRUCTION_FILE_NAMES` at `:26`) walking up from the workspace
  to the git root inclusive, never above (`instructionSearchDirs`, `:76`), plus
  `${XDG_CONFIG_HOME:-~/.config}/jevcode/AGENTS.md` (`xdgJevcodeDir`, `credentials.ts:66`);
- `INSTRUCTIONS_MAX_BYTES = 32 KiB` per file (`:22`), truncated with a notice; a file over
  `INSTRUCTIONS_READ_CAP_BYTES = 4 MiB` (`:24`) is skipped with a notice and never read;
- redacted at read time, default `patternRedact` (`:16`), so a caller that forgets the config redactor still
  gets the safe layer;
- recorded as `run.json.instructions[]` = `InstructionRecord {path, sha256, bytes}` and injected into the
  **generator system prompt only** (D6), as `## Project instructions (from <path>, sha256 <8>)`
  (`instructionsHeader`, `:91`);
- a symlinked instruction file is followed only while its realpath stays inside the tree it was found in
  (`isInside` `:69`, `realOrSelf` `:118`, the deny notice at `:124`) — a repository cannot point `AGENTS.md` at
  `~/.ssh/id_rsa`;
- read **once per run, after the first frame** (F1), and gated by the workspace trust decision
  (`evaluateTrust`, `trust.ts:119`; `probeTrustInputs`, `:238`).

Everything below preserves all seven of those properties and adds nothing that violates them.

### 2.2 Layout

```
<repo>/AGENTS.md                          always on    (exists; import appends a markered block)
<repo>/.jevcode/memory/MEMORY.md          always on    index, ≤ 200 lines / 8 KiB
<repo>/.jevcode/memory/<slug>.md          on demand    topic file, ≤ 8 KiB
<repo>/.jevcode/memory-local/<slug>.md    on demand    personal, git-ignored (CLAUDE.local.md, *.local.json)
<repo>/.jevcode/rules/<slug>.md           path-scoped rule, ≤ 4 KiB
<repo>/.jevcode/commands/<name>.md        inert command (A63), ≤ 8 KiB
<repo>/.jevcode/mcp.json                  MCP servers, every one `enabled: false` on arrival
~/.config/jevcode/AGENTS.md               always on    (exists)
~/.config/jevcode/memory/{MEMORY.md,<slug>.md}
~/.config/jevcode/rules/<slug>.md
~/.config/jevcode/commands/<name>.md
~/.config/jevcode/mcp.json
~/.config/jevcode/imports.json            the manifest (0600), keyed by workspace [G1.3]
~/.jevcode/imports/<importId>/            report.md · plan.json · sources.jsonl · apply.jsonl · pre/ · raw/ (opt-in)
```

**Modes.** Workspace files `0644` — they are meant to be committed — except `memory-local/**` at `0600`.
Everything under the config dir is `0600` in a `0700` dir, through the same policy `writeJsonSecure`
(`credentials.ts:180`) already applies, with the `WINDOWS_ACL_NOTE` (`credentials.ts:29`) on `win32`.
`~/.jevcode/imports/<id>/**` is `0600` in a `0700` dir: the report names paths and counts, and it sits under
the existing `(deny file-read-data (subpath ~/.jevcode))` (`seatbelt.ts:170`) so a sandboxed command cannot
read it. That placement is deliberate, not incidental.

**Why the workspace for project memory.** It must be committable, reviewable in a PR and shareable with the
team — that is the point of a project rule. §2.11 states the sandbox consequence and closes it.

### 2.3 Topic-file format

```markdown
---
name: branch-state-llm-jev-int
description: what the llm-jev worktree was mid-way through, and why round 3 gates it
kind: project            # project | preference | reference | feedback | rule
paths:                   # optional; absent = index-only, loaded on demand
  - "src/loop/**/*.ts"
scope: project           # project | project-local | user
source:
  tool: claude-code
  path: ~/.claude/projects/-Users-…-JevCode/memory/project-jevcode.md
  sha256: 9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211ffeeddccbbaa99
  imported: 2026-09-21T12:00:00.000Z
  importId: imp_20260921T120000Z_a1b2c3
  tools: [claude-code, codex]      # present only when N detectors found the same realpath
redacted: 0              # count of `[REDACTED:*]` substitutions made at write time
clipped: 0               # bytes dropped by the cap, 0 when whole
---
<body — redacted, bidi-stripped, CRLF-normalised, ≤ 8 KiB with a clip notice>
```

`kind` accepts Claude Code's four `type` values (`user`→`preference`, `feedback`, `project`, `reference`) from
**either** a flat top-level `type:` (what the docs describe) **or** a nested `metadata.type:` (what all 43
topic files on this machine actually use). Neither present ⇒ `kind: reference`. Accepting both is the whole
mitigation for the format-drift hazard, and it costs four lines in `kindOf(fm)`.

`name` is **not** the filename. The filename is `slugOf(name)`, sanitised and confined — §4.7.3 **[G1.2]**.

### 2.4 `MEMORY.md` index grammar

```markdown
<!-- jevcode:memory-index v1 -->
# Memory

- [Branch state: llm-jev-int](branch-state-llm-jev-int.md) — the worktree's mid-way state and why round 3 gates it · project · 9f8e7d6c
- [Prefers terse diffs](prefers-terse-diffs.md) — no prose before a patch · preference · 1a2b3c4d
```

The line grammar is `- [Title](file.md) — summary · <kind> · <sha8>`, a **superset** of Claude Code's observed
`- [Title](file.md) — summary` (all index lines in all four `MEMORY.md` files on this machine match it), so a
Claude index imports line-for-line and a JevCode index is still readable by Claude. The HTML comment on line 1
is the format marker; Claude Code strips block-level HTML comments when loading, so it costs the other tool
nothing.

### 2.5 Rules

Same frontmatter with `kind: rule`, `paths:` **required** (a rule without a scope is a memory item, not a
rule), and `trigger: always | paths | manual` mapped from the source:

| Source | Source field | `trigger` | `paths` |
| --- | --- | --- | --- |
| Cursor `.mdc` | `alwaysApply: true` | `always` | — |
| Cursor `.mdc` | `globs:` | `paths` | the globs |
| Cursor `.mdc` | `description:` only | `manual` | — |
| Claude `.claude/rules/*.md` | `paths:` present | `paths` | the globs |
| Claude `.claude/rules/*.md` | no `paths:` | `always` | — |
| Windsurf / Devin | `trigger: always_on` | `always` | — |
| Windsurf / Devin | `trigger: glob` + `globs:` | `paths` | the globs |
| Windsurf / Devin | `trigger: model_decision` | `manual` | — (the description is the selector) |
| Copilot `.instructions.md` | `applyTo: "**/*.ts,**/*.tsx"` | `paths` | split on `,`, trimmed |
| `.cursorrules`, `.windsurfrules`, `global_rules.md` | — | `always` | — |

**Glob budget** `rulePatterns: 200` per rule: brace expansion is applied, then the list is capped with a
`warnings` entry. Claude Code's own budget is 1,000 patterns / 4 MiB; 200 covers every real rule observed and
bounds the per-step matcher. **`ruleFiles: 200`** caps the number of rule files a session will match against
per step **[G1.6]** — without it, a monorepo with a rule per package makes `matchRules` the most expensive
thing in the step.

A `trigger: always` rule is **not** promoted into `AGENTS.md`; it becomes a rule file with `paths: ["**"]` and
is therefore matched by every step. The distinction matters for §1 property 11 and for uninstall: removing a
rule file removes the rule.

### 2.6 Commands (A63, already reserved)

`registry.ts:45` reserves `CommandCategory = … | 'project'`, but `COMMANDS` (`:102`) is a static `readonly`
array and `BY_NAME` (`:557`) is built once at module load, consulted by the single lookup `findCommand`
(`:576`). There is **no dynamic-registration seam today**; §5.8.3 adds one without making the table mutable.

````markdown
---
description: run the failing test and explain the first error
argument-hint: "<test path>"
scope: project
source: {tool: claude-code, path: ~/.claude/commands/ft.md, sha256: …, imported: …, importId: …}
executable-stripped: 2
---
Run $1 and explain the first failure.

Before this command existed, the source ran shell when the command loaded. The two segments are kept as text:

```text (not run)
npm test -- $1
```
````

`$ARGUMENTS` and `$1`…`$9` are kept (JevCode's own substitution, A63). Every `` !`cmd` ``, ```` ```! ````,
`!{cmd}`, `@{file}`, `$(cmd)` and backtick-command form becomes a ```` ```text (not run) ```` fence and
increments `executable-stripped`. **No shell injection, ever.**

### 2.7 MCP

`.jevcode/mcp.json`, one normalised dialect:

```json
{ "v": 1,
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "enabled": false,
      "source": { "tool": "cursor", "path": "~/.cursor/mcp.json", "sha256": "…", "importId": "…" },
      "notes": ["env GITHUB_TOKEN held a literal value in the source; only the name was imported"]
    }
  } }
```

Every server arrives `enabled: false`. JevCode has no MCP client today; the file is a **durable, reviewable
record of what the human had**, so that when a client lands the configuration is already there and was never
silently active. `mcpServers: 64` cap. The eight-dialect normalisation table is §3.10.

### 2.8 Limits

Every bound lives in **one** module, `src/core/limits.ts` (see the ordering graft **[G2.2]** in §7.1) —
Appendix B is the literal export. Nothing is truncated silently: every clip emits a `warnings` entry on its
row and a line in the report's `## Notices`.

| Group | Bound | Value | Why |
| --- | --- | --- | --- |
| discover | `walkDepth` | 8 | deepest real artefact observed is `~/.claude/projects/<slug>/<session>/subagents/x.jsonl` (depth 5) |
| | `walkEntries` | 20 000 per root | `~/.claude/projects` alone is 10 220 entries today |
| | `walkMs` | 2 000 per root | a cold NFS `$HOME` must not hang the wizard |
| | `filesPerRow` | 512 | one atlas row cannot produce 3 371 plan rows |
| | `sourceReadCapBytes` | 4 MiB | `= INSTRUCTIONS_READ_CAP_BYTES` (`instructions.ts:24`) |
| | `transcriptScanBytes` | 256 KiB | metadata pass only; the largest transcript here is 151 MB |
| destination | `memoryDirBytes` / `memoryFiles` | 512 KiB / 200 | |
| | `memoryIndexLines` / `memoryIndexBytes` | 200 / 8 KiB | Claude's own index cap is 200 lines / 25 KB |
| | `topicBytes` / `ruleBytes` / `commandBytes` | 8 / 4 / 8 KiB | Windsurf's own rule cap is 12 000 chars → clipped with a notice |
| | `agentsAppendBytes` | 8 KiB | keeps `AGENTS.md` under `INSTRUCTIONS_MAX_BYTES` (32 KiB) with headroom |
| | `rulePatterns` / `ruleFiles` / `mcpServers` | 200 / 200 / 64 | **[G1.6]** adds `ruleFiles` |
| prompt | `memoryIndexPromptBytes` | 8 KiB | system prompt, once per run |
| | `rulesInScopeShare` / `memoryInScopeShare` | 0.10 / 0.14 of the step's context budget **[G2.7]** | see §2.10.3 |
| jev | `jevRequests` / `jevQuestions` | 3 / 400 | `assertQuestionBatch` (`jev/questions.ts:102`) caps at 1 000 |
| | `jevHeadings` / `jevHeadingCells` | 5 / 80 | |
| plan | `planRows` | 2 000 | |
| | `dedupePairs` | 20 000 **[G1.6]** | bounds the O(N²) Jaccard pass |
| artefacts | `reportBytes` / `sourceLineBytes` | 1 MiB / 2 KiB | |
| | `importsKeep` | 10 ids **[G1.4]** | retention, §4.7.6 |

**Over the memory budget:** the *index* is ranked (§4.4.3 group IV) and trimmed; **no note is dropped.** The
remainder lands as on-demand topic files and the report says
`43 notes → 9 indexed, 34 on demand (512 KiB budget)`.

### 2.9 Redaction at write time

Imported text is redacted **when it is written**, not when it is read, with the session's redactor: the exact
`SecretSet` layer first (`config.addSecret` registrations), then the pattern layer (`patternRedact`,
`redact.ts`). So a pasted `sk-ant-api03-…` inside someone's `CLAUDE.md` lands as `[REDACTED:pattern]` and the
row's `warnings` says `1 value redacted`. The same write-time sanitiser strips bidi controls (the `BIDI_RE`
of `session/index.ts:47`) and ANSI escapes, normalises CRLF → LF, strips a BOM, and records
`warnings: ['3 control characters removed']`.

Because redaction happens at write time and the engine re-reads the destination, a secret cannot survive one
hop: it is absent from the plan (no `PlanRow` field holds a value), absent from the destination, and therefore
absent from the prompt.

### 2.10 How the engine consumes them

#### 2.10.1 The constraint that shapes everything

`engine.ts:659-660` builds the system prompt **once per run**:

```ts
const instructions = init.opts.instructions?.text ?? '';
this.systemPrompt = buildSystemPrompt({ mode: this.mode, sandboxLevel: init.sandbox.level, toolName: 'propose_action', … });
```

Therefore **nothing path-scoped can live in the system prompt.** A rule that applies only to `src/loop/**` must
be injected per step, in the user message, or it is not a scoped rule at all. This single fact is why the model
has two layers instead of one file.

#### 2.10.2 The two layers

| Layer | Where | Budget | Order |
| --- | --- | --- | --- |
| `~/.config/jevcode/AGENTS.md` | system prompt, `## Project instructions` (today's section) | 32 KiB | 1 |
| `<repo>/AGENTS.md` | system prompt, same section | 32 KiB | 2 |
| user `MEMORY.md` | system prompt, new `## Memory (index)` | 8 KiB | 3 |
| project `MEMORY.md` | system prompt, `## Memory (index)` | 8 KiB | 4 |
| matched rules | **per-step user message**, new `## Rules in scope` | share, §2.10.3 | 5 (root→leaf) |
| matched / referenced topics | **per-step user message**, new `## Memory in scope` | share, §2.10.3 | 6 |

Root→cwd, closer-and-more-specific **later** = higher effective priority — the same concatenation semantics
Claude Code and Codex both use, so imported content keeps the precedence its author intended.

#### 2.10.3 The per-step sections and their budget **[G2.7]**

The two new sections ride the context fill order of `CD §8.2` (`COORDINATION-DESIGN.md:1103`):

> task → plan (≤ 200) → directives (8 × 600) → kept (≤ 24 × 300) → **rules in scope** → **memory in scope** →
> files in view (≤ 40 %) → recent steps (≤ 30 %) → summary (≤ 6 KiB) → other sessions → candidates

inserted immediately after `kept`, because a memory item *is* a kept item that outlives the run.

The spine sized them as absolutes (12 KiB and 16 KiB). That is wrong at the low end: today's
`PROMPT_LIMITS.contextTotalBytes` is **61 440** (`prompts.ts:11-24`), and `CD §8.2` derives
`contextBudgetChars` from the model's window and the spend cap (`COORDINATION-DESIGN.md:1094`), so at the floor
the two new sections would take ~47 % of the budget *before the first file is added*. They are therefore
**shares**:

```
rulesInScopeBytes  = clamp(round(0.10 × contextBudgetChars), 2 KiB, 12 KiB)
memoryInScopeBytes = clamp(round(0.14 × contextBudgetChars), 2 KiB, 16 KiB)
```

At today's 61 440 that is 6 KiB + 8 KiB = 23 % — behind `files in view`, ahead of nothing that matters. The
absolutes survive as the upper clamps, so a large-window model still gets the spine's numbers. Until
`src/loop/context.ts` lands, `contextBudgetChars` falls back to `PROMPT_LIMITS.contextTotalBytes`.

#### 2.10.4 Rule activation

`matchRules(rules, paths)` in `src/import/rules.ts` — pure, dependency-free (a small glob matcher over the
already-capped 200 patterns), memoised per step. `paths` is the step's files in view: the generator's
`read`/`edit`/`write`/`patch` targets plus `pinnedFiles` (`session/seed.ts:28`) — the same set `CD §8.2`
(`:1128`) uses. A rule with no match contributes nothing and costs one memoised glob test.

#### 2.10.5 Chat

`buildChatRequest` (`chat/llm-turn.ts:92-96`) appends `## Instructions (AGENTS.md)` only when trusted, after
`## Session facts`. It gains `## Memory (index)` immediately after, **same trust gate**, 8 KiB.

`src/chat/facts.ts` gains a **15th** `FactKey` — `memory` (`FactKey` at `:17` has 14 members today) — so *"what
do you remember about this repo?"* is answered from the index with **no run and no LLM call**:

```
memory: 9 notes indexed, 34 on demand · .jevcode/memory (project), ~/.config/jevcode/memory (user) · /memory to list
```

`FACT_KEYS` is a closed union; the addition is one union member (`:17`), one `FACT_KEYS` entry (`:18`), one
`FACT_TOPICS` row (`:56`), one `FACT_EXAMPLES` array (`:74` — `"what do you remember"`, `"do you know this
repo"`, `"what did I tell you before"`, `"what's in your memory"`), one `FACT_FALSE_EXAMPLES` array (`:92`) and
one `text` line built from live counts (`:188`).

#### 2.10.6 Jev

Jev's own state (`src/loop/state.ts`, `recent` 4 × 600 chars) carries no instruction text today and does not
change: memory reaches Jev only through the generator's prompt and through `kept` items. The one addition is
`CheckpointState.kept?[].kind` gaining `'memory'` — and `kept` itself is a **coordination-design addition**
(`CD` `:1174`, not in `core/types.ts` at `5a167b2`), so this is an amendment to that row, not an independent
change **[G2.2]**.

### 2.11 Sandbox posture — and the hole the spine did not actually close **[G2.1]**

`seatbelt.ts` builds an SBPL profile where **later rules win** (`:8-9`). The read rules are, in emission order:

```
:163   (deny file-read*      <readDenies> <HOME_SECRET_SUBPATHS> <configDirs>)   ← what addRead() feeds
:170   (deny file-read-data  (subpath ~/.jevcode))
:180   (allow file-read-data (subpath <ws>) (subpath <runTmp>) (subpath <runHome>) …)
:181   (allow file-read*     (subpath <ws>) (subpath <runTmp>) (subpath <runHome>) …)
```

The write rules are `:102` `(deny file-write*)`, `:104` `(allow file-write* (subpath <ws>) …)`, then `:134`
`(deny file-write* <gitDenies> <ttyDeny>)`.

So:

- **The three write denies are sound as the spine specified them.** `:134` is emitted *after* the `:104`
  allow, which is exactly why the `.git/config` and `.git/hooks` denies work. Adding
  `<ws>/.jevcode/{memory,rules,commands}` (literal + subpath, the `addRead` idiom at `:150-151` applied to
  writes) to `gitDenies` is correct: the agent may **read** its own memory — it is supposed to — but a run
  must not rewrite the memory that steers the next run.
- **The read deny for `memory-local/**` as the spine specified it does not work.** Routing it through
  `addRead` puts it in the `:163` deny, which the `:181` `(allow file-read* (subpath <ws>) …)` then overrides,
  because `<ws>` is a writable root and therefore in `roots`. The 0600 personal-memory files would stay
  readable by any sandboxed command.
- **Fix:** emit it as a **new line after `:181`**, naming the operation explicitly, exactly as the
  `:170`/`:180` pair already does for `~/.jevcode`:
  ```
  (deny file-read* (literal "<ws>/.jevcode/memory-local") (subpath "<ws>/.jevcode/memory-local"))
  ```
  A deny on a family emitted after the allow wins; `:171-172` records the verified macOS 26 behaviour this
  relies on.
- **Gate:** an SBPL snapshot test asserting (a) the three write-deny fragments appear in the `:134` line, and
  (b) the `memory-local` deny's line **ordinal is greater** than both `(allow file-read-data …)` and
  `(allow file-read* …)`. Ordinal, not presence — presence is what the spine asserted and presence is not the
  property that matters.

`protectGit: false` (the bench's infrastructure sandbox) suppresses `gitDenies`; the memory write denies ride
the same flag, because that profile is a fresh clone into the root and has no memory to protect.

### 2.12 When it takes effect

The system prompt is built once per run (`engine.ts:660`) and instructions are read once per run after the
first frame. Therefore:

| Change | Active |
| --- | --- |
| `jevcode import` from the shell | the next `jevcode chat` / `jevcode run` |
| `/import` in a live session, always-on layers (`AGENTS.md`, `MEMORY.md`) | the next run; `/new` starts one here |
| `/import` in a live session, rules and topic files | **immediately** — they are re-read per step |
| `/memory add` / `/memory forget` | same split |

That asymmetry is stated in the item text (`[import] active from the next run · /new starts one here`), not
hidden. §6 row 76 **[G2.8]** pins the one race it creates.

---

## §3 Sources and detectors

### 3.1 The detector shape

One row of the atlas is one `SourceSpec`, and the atlas is the only place a tool's knowledge lives:

```ts
interface RootSpec {
  kind: 'home' | 'repo' | 'managed';
  /** checked BEFORE the default, in order; the report names which one fired */
  envOverride?: readonly string[];   // e.g. ['CLAUDE_CONFIG_DIR']
  path: string;                      // '~/.claude' | '<repo>' | '/Library/Application Support/Claude'
  platform?: readonly NodeJS.Platform[];
}
interface SourceSpec {
  id: string;                        // 'claude.auto-memory.topic'
  tool: SourceTool;                  // 'claude-code' | 'codex' | … | 'mcp'
  artefact: string;                  // human label for the report
  roots: readonly RootSpec[];
  pattern: string;                   // glob, relative to the root
  format: SourceFormat;
  class: ImportClass;                // the atlas-class verdict, rule 6 after the 2026-09-22 amendment (§4.4.1)
  scope: SourceScope;
  destination: DestinationSpec;      // where a row of this kind lands
  precedence?: number;               // within a tool, for "first match wins" chains
  notes?: readonly string[];         // rendered in the report when the row is skipped
}
```

~70 rows. `rootFor(spec, env, home, platform)` is pure and is the **only** place an environment override is
read, so §6 rows 1–4 are one test over a table rather than nine special cases.

### 3.2 Claude Code — root `${CLAUDE_CONFIG_DIR:-~/.claude}`

Docs: `https://code.claude.com/docs/en/memory`, `/skills`, `/sub-agents`, `/hooks`, `/mcp`, `/settings`,
`/settings-reference`, `/workflows`, `/plugins-reference`, `/claude-directory`, `/commands`.

| Artefact | Paths | Fmt | Class | Destination |
| --- | --- | --- | --- | --- |
| user instructions | `~/.claude/CLAUDE.md` | md | M/user | `~/.config/jevcode/AGENTS.md` (append) |
| project instructions | `<repo>/CLAUDE.md`, `<repo>/.claude/CLAUDE.md`, ancestors and subdirs | md | M/project | `<repo>/AGENTS.md` (append) at root; a subdir file → `memory/<slug>.md` with `paths: ["<subdir>/**"]` |
| personal-uncommitted | `<repo>/CLAUDE.local.md` | md | M/project-local | `memory-local/<slug>.md` |
| rules | `~/.claude/rules/*.md`, `<repo>/.claude/rules/**/*.md` | md + `paths:` | M/rule | `rules/<slug>.md` |
| auto memory | `~/.claude/projects/<slug>/memory/{MEMORY.md,*.md}`; override `autoMemoryDirectory` | md + frontmatter | M/learned | `memory/MEMORY.md` + `memory/<slug>.md` |
| agent memory | `~/.claude/agent-memory/<a>/`, `<repo>/.claude/agent-memory{,-local}/<a>/` | md | M/learned | `memory/agent-<a>-<slug>.md` |
| skills | `~/.claude/skills/<n>/SKILL.md`, `<repo>/.claude/skills/<n>/SKILL.md`, `<subdir>/.claude/skills/` | md + frontmatter | W | `commands/<n>.md`; supporting files listed, not copied |
| legacy commands | `~/.claude/commands/*.md`, `<repo>/.claude/commands/*.md` | md | W | `commands/<n>.md` (a skill of the same name wins) |
| subagents | `~/.claude/agents/**/*.md`, `<repo>/.claude/agents/**/*.md` | md + frontmatter | W | `memory/agent-<name>.md` `kind: reference` + a report note (JevCode has no subagent surface) |
| saved workflows | `~/.claude/workflows/*.js`, `<repo>/.claude/workflows/*.js` | js | **X** | `skip:unsupported`; `meta.name` / `meta.description` shown so the human knows what they had |
| settings | `~/.claude/settings.json`, `<repo>/.claude/settings{,.local}.json`, `managed-settings.json` | json | C + S + W | per key, §4.4.2 |
| global config | `~/.claude.json` | json | C + S | `mcpServers` → `mcp.json`; `oauthAccount` → **named, not read** |
| project MCP | `<repo>/.mcp.json` | json | C | `mcp.json` |
| credentials | `~/.claude/.credentials.json`, `~/.claude/sessions/*.key` | json | S | named, not read |
| transcripts | `~/.claude/projects/<slug>/*.jsonl`, `<session>/{subagents,tool-results,workflows}/` | jsonl | T | `skip:transcript` unless `--source claude-transcripts` (§4.2.6) |
| prompt history | `~/.claude/history.jsonl` | jsonl | T | **never** |
| shell snapshots | `~/.claude/shell-snapshots/*.sh` | sh | X | **never** (environment dumps) |
| plugins | `~/.claude/plugins/installed_plugins.json` + `cache/*/.claude-plugin/plugin.json` | json | W | names + versions in the report; contents `skip:third-party` |
| keybindings | `~/.claude/keybindings.json` | json | C | offered as a `~/.config/jevcode/keybindings.json` merge, action-name-mapped; unmapped actions reported (§9.3) |

**Hierarchy and imports.** Every `CLAUDE.md`/`CLAUDE.local.md` from cwd up to the filesystem root loads at
launch, concatenated root→cwd (closer = later = higher priority), `CLAUDE.local.md` after its sibling.
`@path` imports resolve relative to the **containing file**, allow absolute and `@~/…`, recurse to depth 4,
and are ignored inside code spans and fences. JevCode inlines them once, then dedupes the inlined content
against its own row (§6 row 27 — `CoArena/CLAUDE.md` on this machine is exactly the 11 bytes `@AGENTS.md\n`).

**AGENTS.md precedence.** Claude Code (v2.1.277+) reads `AGENTS.md` directly **only** when no `CLAUDE.md` /
`.claude/CLAUDE.md` / `CLAUDE.local.md` exists in cwd or any ancestor. JevCode's importer does not replicate
that gate — it imports both when both exist and reports the pair as a duplicate group (§4.5), because the
human's intent, not Claude's fallback rule, decides what JevCode should remember.

**Project slug.** Claude's slug is the absolute path with `/`→`-`, which is **not reversible** when the path
contains `-` (observed on this machine:
`-Users-prateekjannu-Documents-vscode-JevCode--claude-worktrees-llm-jev-int`). Resolution order:
`~/.claude.json` `projects` keys (absolute paths) → a transcript record's `cwd` field → reported `unmapped`
with the human asked to pick. Auto memory is documented as derived from the git repository, so worktree slugs
share one memory dir; the importer merges by resolved repo root and says so.

### 3.3 Codex — root `${CODEX_HOME:-~/.codex}`

Docs: `https://learn.chatgpt.com/docs/agent-configuration/agents-md`,
`https://learn.chatgpt.com/docs/config-file/config-reference`.

| Artefact | Paths | Fmt | Class | Destination |
| --- | --- | --- | --- | --- |
| global instructions | `~/.codex/AGENTS.override.md` **else** `~/.codex/AGENTS.md` | md | M/user | `~/.config/jevcode/AGENTS.md` |
| project instructions | git root → cwd at each level: `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` | md | M/project | `<repo>/AGENTS.md` at root; below root a topic with `paths:` |
| memories | `~/.codex/memories/{MEMORY.md,memory_summary.md,raw_memories.md,rollout_summaries/,skills/}` when `[features] memories=true` | md | M/learned | `memory/` |
| prompts | `~/.codex/prompts/*.md` | md | W | `commands/<n>.md` |
| skills | `~/.codex/skills/<n>/SKILL.md`, `<repo>/.codex/skills/`, `.agents/skills/` — **never** `skills/.system/**` | md | W | `commands/<n>.md` |
| approval rules | `~/.codex/rules/*.rules` (`prefix_rule(pattern=[…], decision="allow")`) | custom | C/permission | `## Suggested permissions (not applied)` |
| config | `~/.codex/config.toml` | toml | C + S | per key; `[mcp_servers.*]` → `mcp.json`; `[projects."<p>"] trust_level` → suggestion |
| auth | `~/.codex/auth.json` (0600) | json | S | named, not read |
| sessions & state | `sessions/YYYY/MM/DD/rollout-*.jsonl`, `archived_sessions/`, `session_index.jsonl`, `state_5.sqlite`, `thread_history_1.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`, `logs_2.sqlite`, `queue_1.sqlite` | jsonl / sqlite | T | `skip:transcript` / `skip:unsupported` |

Codex's combined project-doc cap is `project_doc_max_bytes` (default 32 KiB) and empty files are skipped —
JevCode reproduces neither on import (it imports each file separately with its own cap) but **reports** when
the source chain would have exceeded it, so a human who relied on the cut knows.

### 3.4 opencode

Docs: `https://opencode.ai/docs/config/`, `/rules/`, `/agents/`, `/commands/`, `/skills/`, `/share/`,
`/troubleshooting/`.

| Artefact | Paths | Class |
| --- | --- | --- |
| rules | `<repo>/AGENTS.md` walking up (`CLAUDE.md` fallback), `~/.config/opencode/AGENTS.md`, and the Claude-compat `~/.claude/CLAUDE.md` | M |
| extra instructions | every entry of `instructions[]` (paths/globs) — **`https://` entries are reported, never fetched** | M |
| agents | `~/.config/opencode/agents/*.md`, `<repo>/.opencode/agents/*.md` (+ singular legacy `agent/`) | W |
| commands | `~/.config/opencode/commands/*.md`, `<repo>/.opencode/commands/*.md`, or the `command` key | W |
| skills | `.opencode/skills/<n>/SKILL.md`, `~/.config/opencode/skills/`, compat `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`, `~/.agents/skills/` | W |
| config | `opencode.json` / `opencode.jsonc`, `$OPENCODE_CONFIG`, `$OPENCODE_CONFIG_CONTENT`, managed `/Library/Application Support/opencode/`, `/etc/opencode/` | C (`mcp`, `permission`, `keybinds`, `model`) |
| auth | `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`; `provider.*.options.apiKey` | S |
| sessions | legacy `storage/session/**` + `storage/message/**` JSON, newer `opencode.db` | T / `skip:unsupported` (§9.5) |

`{env:VAR}` and `{file:path}` substitution is normalised on import (§3.10). `OPENCODE_DATA_DIR` is
**comma-separated**: all roots are scanned and deduped by realpath (§6 row 3).

### 3.5 Cursor

Docs: `https://cursor.com/docs/context/rules`, `https://cursor.com/docs/context/mcp`.

| Artefact | Paths | Class | Notes |
| --- | --- | --- | --- |
| rules | `.cursor/rules/**/*.mdc` (nested dirs allowed) | M/rule | frontmatter `description`, `globs`, `alwaysApply` → the four rule types of §2.5 |
| legacy rules | `./.cursorrules` (plain text, deprecated) | M/rule `always` | |
| agents file | `AGENTS.md` at root and subdirs | M | shared realpath with four other detectors (§4.2.3) |
| MCP | `.cursor/mcp.json`, `~/.cursor/mcp.json` | C | `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`, `envFile` |
| **User Rules** | Cursor **account**, not disk (the legacy `state.vscdb` key `aicontext.personalContext` is declared stale by staff) | — | §3.11 paste route |
| chat history | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, `workspaceStorage/<hash>/state.vscdb` | T | `skip:unsupported` (sqlite, §9.5) |

`@filename.ts` references inside `.mdc` bodies are resolved like an `@import` (root-confined, depth 4) and
otherwise preserved as text.

### 3.6 Windsurf / Devin

Docs: `https://docs.devin.ai/desktop/cascade/memories`, `https://docs.devin.ai/desktop/cascade/mcp`.

| Artefact | Paths | Class | Notes |
| --- | --- | --- | --- |
| global rules | `~/.codeium/windsurf/memories/global_rules.md` | M/user, `always` | 6 000-char source limit |
| workspace rules | `.devin/rules/*.md` (preferred), `.windsurf/rules/*.md` (legacy fallback) | M/rule | 12 000-char source limit → clipped to `ruleBytes` with a notice (§6 row 52) |
| legacy rules | `./.windsurfrules` | M/rule `always` | |
| workflows | `.windsurf/workflows/*.md` (frontmatter `description`, invoked `/<name>`) | W | `commands/<n>.md` |
| Cascade memories | `~/.codeium/windsurf/memories/**` (auto-generated, undocumented format) | M? | **best-effort**: files that parse as markdown with a heading are offered; the rest are `skip:unknown-format` and listed in §3.11 |
| MCP | `~/.codeium/windsurf/mcp_config.json` | C | `serverUrl` (not `url`), `${env:VAR}`, `${file:/path}` |

### 3.7 Aider

Docs: `https://aider.chat/docs/usage/conventions.html`, `/docs/config/aider_conf.html`,
`/docs/config/dotenv.html`.

| Artefact | Paths | Class | Notes |
| --- | --- | --- | --- |
| conventions | `CONVENTIONS.md` and **every path named by `read:`** in `.aider.conf.yml` (string or list) | M | the `read:` list is the real source of truth; `CONVENTIONS.md` is only a convention |
| config | `.aider.conf.yml` searched home → git root → cwd (later wins), or `--config` | C + S | `model`, `weak-model`, `editor-model`, `alias`, `lint-cmd`, `test-cmd`, `auto-commits`, `aiderignore` |
| model settings | `.aider.model.settings.yml`, `.aider.model.metadata.json` | C | reported, not mapped (no JevCode equivalent) |
| test/lint commands | `lint-cmd`, `test-cmd` | W | a **suggestion** row: `suggested test command: <cmd> — /config test.command` |
| secrets | `*-api-key` keys in the conf; `.env` at home → git root → cwd → `--env-file` | S | names and counts only |
| histories | `.aider.chat.history.md`, `.aider.input.history`, `.llm-history-file` | T | `skip:transcript` |
| cache | `.aider.tags.cache.v*/` | X | excluded by the walk |

### 3.8 Gemini CLI

Docs: `https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html`,
`https://geminicli.com/docs/cli/gemini-md/`, `/docs/cli/custom-commands/`, `/docs/tools/mcp-server/`,
`/docs/cli/checkpointing/`.

| Artefact | Paths | Class | Notes |
| --- | --- | --- | --- |
| context files | `~/.gemini/GEMINI.md`, then project root and ancestors (to `.git` or home), then subdirs just-in-time; the **names** come from `context.fileName` (string or array, e.g. `["AGENTS.md","CONTEXT.md","GEMINI.md"]`) | M | the importer reads `context.fileName` **before** globbing, so a renamed context file is still found (§6 row 6a) |
| imports | `@file.md` inside context files | M | resolved root-confined, depth 4 |
| commands | `~/.gemini/commands/**/*.toml`, `.gemini/commands/**/*.toml` (dir/ → `/dir:name`) | W | TOML `prompt` (required) + `description`; `{{args}}` kept, `!{shell}` fenced, `@{file}` resolved |
| settings | `~/.gemini/settings.json`, `.gemini/settings.json`, system-defaults (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`), system settings (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) | C + S | values may reference `$VAR` / `${VAR}` |
| MCP | `mcpServers` in either settings file | C | `url` (SSE) **vs** `httpUrl` (streamable HTTP) — the only source that distinguishes them |
| secrets | `~/.gemini/mcp-oauth-tokens.json`, `~/.gemini/.env`, `.gemini/.env`, `mcpServers.*.oauth.clientSecret` | S | named, not read |
| checkpoints | `~/.gemini/tmp/<project_hash>/checkpoints`, shadow git `~/.gemini/history/<project_hash>` | T | `skip:transcript` |
| ignore | `.geminiignore` | C | reported; JevCode has its own ignore rules |

### 3.9 GitHub Copilot / VS Code

Docs: `https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions`,
`https://code.visualstudio.com/docs/copilot/customization/custom-instructions`.

| Artefact | Paths | Class | Notes |
| --- | --- | --- | --- |
| repo instructions | `.github/copilot-instructions.md` | M/project | |
| scoped instructions | `.github/instructions/<name>.instructions.md` | M/rule | frontmatter `applyTo` (comma-separated globs), `description`, `excludeAgent` |
| user instructions | `~/.copilot/instructions/**` | M/user | absent on this machine (only `config.json`, `logs/`, `ide/*.lock`) |
| agents file | `AGENTS.md` at root and nested (nearest wins) | M | |
| prompts | `.github/prompts/*.prompt.md` | W | frontmatter `mode`, `model`, `tools`, `description`, `agent` |
| agents | `.github/agents/*.agent.md` | W | `memory/agent-<name>.md` `kind: reference` |
| MCP | `.vscode/mcp.json` — `servers`, `inputs[]`, `envFile` | C | `${input:id}` → `${ID_UPPER}` with a note (§3.10) |
| tool config | `~/.copilot/config.json` ("managed automatically") | X | `skip:tool-managed` |

Priority in Copilot is personal > repository > organization; JevCode maps personal → user scope, repository →
project scope, and cannot see organization instructions (§3.11).

### 3.10 Claude Desktop, and the MCP dialect table

Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json`
(Linux) — shape `{"mcpServers":{name:{command,args,env}}}`
(`https://modelcontextprotocol.io/docs/develop/connect-local-servers`). **No expansion syntax at all**: every
`env` value is a literal, so this is the dialect most likely to hold a raw credential.

Eight dialects, one record (`src/import/mcp.ts`):

| Source | transport key | url key | env-reference syntax | extras dropped (and reported) |
| --- | --- | --- | --- | --- |
| Claude Code `.mcp.json` / `~/.claude.json` | `type` | `url` | `${VAR}`, `${VAR:-default}` | `headersHelper`, `oauth`, `alwaysLoad` |
| Cursor | — (inferred) | `url` | `${env:VAR}`, `${workspaceFolder}`, `${userHome}`, `${pathSeparator}` | `envFile` |
| Windsurf / Devin | — | **`serverUrl`** | `${env:VAR}`, `${file:/p}` | — |
| Gemini CLI | — | `url` (SSE) / **`httpUrl`** (HTTP) | `$VAR`, `${VAR}`, `%VAR%` | `oauth.clientSecret` (**S**), `trust` (permission); `includeTools`/`excludeTools` kept |
| opencode `mcp` | `type` | `url` | `{env:VAR}`, `{file:p}` | — |
| Codex `[mcp_servers.<n>]` | — | `url` | `env_key`, `bearer_token_env_var` (variable **names**) | `enabled_tools`/`disabled_tools` kept |
| VS Code `.vscode/mcp.json` | `type` | `url` | `${input:id}` + `inputs[]` | `envFile` |
| Claude Desktop | — | — | none (literal values) | — |

Normalisation: every form → `${VAR}`. `${workspaceFolder}` → `${JEVCODE_WORKSPACE}`; `${userHome}` →
`${HOME}`; `${pathSeparator}` → `/`; `${input:id}` → `${<ID_UPPER>}` with a note naming the original prompt.
Transport inferred when absent: `command` present → `stdio`; `httpUrl` → `http`; `url` ending `/sse` or
declared SSE → `sse`; otherwise `http`. **Credential-looking variables (`SECRET_NAME_RE`, `redact.ts:56`) are
never expanded into a remote `url` or `headers`** — the same rule Claude Code itself applies.

### 3.11 Sources that are not on disk

The report always renders `## Cannot be read from disk`, **even when empty**, so "nothing found" never reads
as "you have nothing".

| What | Why | Route |
| --- | --- | --- |
| Cursor **User Rules** | stored on the Cursor account | `/memory add`, or `jevcode import --from -` |
| Cursor **Team Rules** | dashboard-managed | same |
| Windsurf **Cascade memories** | machine-local, undocumented format | best-effort parse (§3.6), else `/memory add` |
| Codex **memories** | `[features] memories = false` on this machine → the dir does not exist | `enable, use Codex once, re-run import` |
| Copilot **organization** instructions | server-side | `/memory add` |
| opencode **share** history | uploaded to `opncd.ai/s/<id>` | not imported; a notice names it |
| ChatGPT / Claude.ai **connectors** | account-side OAuth | never imported; `mcp.json` records nothing |

`jevcode import --from -` reads markdown from stdin into `memory/pasted-<ts>.md` (`kind: preference`,
`source.tool: pasted`). `/memory add` opens the composer in a multi-line draft that lands the same way. Both
run the redactor and refuse a body that `detectSecrets` flags without an explicit second `y`.

### 3.12 Local inventory, measured 2026-09-21 on the author's machine

Read-only; counts and sizes only; **no key, no memory body and no transcript body was read or printed.**

| Fact | Value |
| --- | --- |
| tools present | `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.copilot` |
| tools absent | `~/.cursor`, `~/.gemini`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.codeium/windsurf`, `~/.aider.conf.yml`, Claude Desktop |
| `~/.claude` contents | `backups cache downloads file-history ide policy-limits.json remote-settings.json projects session-env sessions settings.json shell-snapshots telemetry` — **no** `CLAUDE.md`, `rules/`, `skills/`, `commands/`, `agents/`, `plugins/`, `keybindings.json`, `history.jsonl`, `.credentials.json` |
| `~/.claude` total | 3 331 MB |
| Claude project slugs | 12 |
| memory dirs | 5 (CoArena 33, coarena-rl-envs 6, open-assist 5, vscode 3, JevCode 0) |
| memory files | **47 markdown files = 43 topic files + 4 `MEMORY.md` indexes** |
| `~/.claude/projects` walk | 10 220 entries, 9 911 files |
| transcripts | **3 371** `.jsonl`, **2.7 GB** total; 20 over 5 MB; largest **151 MB**, then 104, 79, 27 |
| Codex | `config.toml` with **3** `[mcp_servers.*]` and **6** `trust_level` entries; `rules/`, `skills/`, `sessions/` (23 rollouts, 2 541 MB), `auth.json`, 6 sqlite DBs; **no** `AGENTS.md`, `prompts/`, `memories/` |
| Copilot | `~/.copilot/{config.json,logs/,ide/}` — no instructions dir |
| worktrees | `JevCode/.claude/worktrees/` = **25** checkouts, 2 227 MB, ~1 992 entries each (~50 000 entries if walked) |
| sibling instruction files | `CoArena/CLAUDE.md` (**11 B** = `@AGENTS.md`), `CoArena/AGENTS.md` (678 B), `coarena-rl-envs/AGENTS.md` (5 732 B) |
| JevCode itself | **no** `AGENTS.md`, **no** `CLAUDE.md`; `.claude/` holds only `worktrees/` |
| secrets to expect | `~/.claude/settings.json` `env.ANTHROPIC_API_KEY`; `~/.claude.json` `oauthAccount.{token,refreshToken}`; `~/.codex/auth.json`; `~/.claude/sessions/*.key` |
| key-like tokens in the 43 memory bodies | **0** (regex scan by the source survey; bodies not printed) |

Three of these numbers change the design, not just the report:

1. **2.7 GB of transcripts across 3 371 files** is why transcripts are `skip:transcript` by default and why
   the opt-in pass is a 256 KiB stream parse (§4.2.6), not a read.
2. **25 worktrees × ~1 992 entries ≈ 50 000 entries**, each holding a copy of `docs/`, `src/`, `test/` — more
   than double `walkEntries` from one directory, and 25 duplicates of every instruction-shaped file. The
   `**/.claude/worktrees/**` exclusion is load-bearing, not hygiene (§6 row 6).
3. **JevCode has no `AGENTS.md`**, so the very first real import is a `create`, not an `append`, and the trust
   re-pin path (§4.7.5) is exercised on run one.

---

## §4 The import engine — `src/import/**`

### 4.1 Pipeline and module map

```
                    ┌─────────────────────────────── writes nothing outside ~/.jevcode/imports/<id>/ ──┐
  roots ──▶ detect ──▶ read ──▶ map ──▶ classify ──▶ conflicts ──▶ dry-run report ──┼──▶ apply ──▶ manifest
            │         │        │        │             │             │               │     │
   sources.ts  discover.ts  parse/**  classify.ts   plan.ts       report.ts         │  apply.ts
                                      secrets.ts                                    │  mcp.ts
                                      questions.ts                                  │  (via write seams)
                                                                                    └── human approval
```

| Module | Purpose | Pure? |
| --- | --- | --- |
| `src/import/sources.ts` | the atlas (§3) + `rootFor()` | pure |
| `src/import/discover.ts` | bounded walk, realpath identity, transcript metadata pass | read-only I/O via seams |
| `src/import/parse/{frontmatter,markdown,mdc,jsonc,toml,jsonl,sqlite}.ts` | tolerant parsers, none of which throws | pure |
| `src/import/classify.ts` | the 12 file rules and the 9 key rules, with bands | pure |
| `src/import/secrets.ts` | value shape, never value retention | pure |
| `src/import/questions.ts` | the five Jev groups, batching, floors, fallbacks | pure + one `Decider.ask` |
| `src/import/plan.ts` | dedupe, conflicts, destinations, slugs, budget, actions | pure |
| `src/import/report.ts` | `report.md` + `plan.json` | pure |
| `src/import/apply.ts` | ordered pipeline over injected write seams; lock, resume, undo | I/O via seams only |
| `src/import/mcp.ts` | the eight-dialect normaliser | pure |
| `src/import/rules.ts` | `matchRules(rules, paths)` for the per-step prompt | pure |

### 4.2 Detect and read (`discover.ts`)

#### 4.2.1 Roots

Home roots, each gated on existence and each honouring its override **before** the default:
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG`,
`OPENCODE_DATA_DIR` (comma-separated), `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`,
`%USERPROFILE%`, `%APPDATA%`, plus the managed dirs `/Library/Application Support/{Claude,GeminiCli,opencode}`,
`/etc/{opencode,gemini-cli}`, `C:\ProgramData\gemini-cli`. Repo roots: the workspace, its git root, and each
`--from <path>` (repeatable). A relative `XDG_CONFIG_HOME` is ignored per spec — the exact rule
`xdgConfigHome` (`credentials.ts:60`) already implements, reused rather than re-derived.

#### 4.2.2 Walk

- **Exclusions, always:** `**/node_modules/**`, `**/.git/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`,
  `**/.next/**`, `**/target/**`, `**/vendor/**`, `**/.venv/**`, `**/__pycache__/**`,
  `**/.claude/worktrees/**`, `**/.jevcode/**` (the destinations), `**/.aider.tags.cache.v*/**`. Plus
  `.gitignore` when `--respect-gitignore` (default **on** for repo roots, off for home roots).
- **Caps:** `walkDepth` 8, `walkEntries` 20 000, `walkMs` 2 000 per root, `filesPerRow` 512. Exceeding any cap
  yields `notice: <root> walk stopped at <cap>` **and the rows found so far** — never an abort.
- **Symlinks:** followed only while the realpath stays inside the root that found it — the exact
  `isInside` / `realOrSelf` policy of `instructions.ts:69,118-124`. A symlink out is `skip:symlink` with the
  reason. A visited `dev:ino` set breaks loops.
- **Secret-named paths** (`isSecretBasename`, `paths.ts:114`; `isMentionDeniedBasename`, `:155`) are **never
  opened for content** — only existence, and for `.env` the variable **names and counts**, through the same
  `readDotenv` (`config/env.ts:27`) probe `probeTrustInputs` (`trust.ts:249`) already performs.
- **Case:** matched case-insensitively on `darwin`/`win32`, exactly on `linux` — corrected by a **per-volume
  probe** rather than by platform **[G1.6]**: write-and-stat a temp name once per root, cache the answer. A
  case-sensitive APFS volume on macOS holding both `CLAUDE.md` and `claude.md` is real and must produce two
  rows, not one merged row (§6 row 16).
- **Non-files:** a FIFO, socket, device or directory where a file is expected is `skip:not-a-file`, decided by
  `stat().isFile()` before any `open` — the `readOne` pattern of `instructions.ts:128`.

#### 4.2.3 Identity and dedupe

Every discovered artefact is keyed by **realpath**. A file matched by N detectors becomes **one**
`SourceItem` with `tools: [t1…tN]` and the union of their interpretations; the report shows
`AGENTS.md · read by codex, opencode, copilot, cursor, claude-code`. An item whose realpath equals a
destination, or an instruction file JevCode has already loaded, is `skip:self`.

#### 4.2.4 The read

Content is read only for rows whose atlas class is M, W or C, only under `sourceReadCapBytes`, and only after
`stat()` said the size is within cap — so the 151 MB transcript is never opened.

#### 4.2.5 Output

`sources.jsonl`, one redacted `SourceItem` per line, ≤ `sourceLineBytes`:

```ts
interface SourceItem {
  id: string;                      // sha256(realpath)[0..12]
  realpath: string; display: string;             // `~/…` via displayPath() (credentials.ts:105)
  tools: readonly SourceTool[];
  artefact: string;                // the atlas row id, e.g. 'claude.auto-memory.topic'
  format: 'md'|'mdc'|'json'|'jsonc'|'toml'|'yaml'|'jsonl'|'sqlite'|'text'|'js'|'sh';
  scope: 'user'|'project'|'project-local'|'managed';
  bytes: number; sha256: string; mtime: string;
  parse: { ok: boolean; error?: string; frontmatterKeys?: readonly string[];
           headings?: readonly string[]; lines?: number; fences?: number };
  notices: readonly string[];
}
```

#### 4.2.6 Transcripts

Never read by default. `--source claude-transcripts | codex-sessions | opencode-sessions | aider-history`
enables a **metadata-only** pass: per transcript, `sessionId`, `cwd`, `gitBranch`, the first user message
(redacted, ≤ 120 chars), `custom-title.json`, timestamps and byte count, via a stream parse that **stops at
`transcriptScanBytes` (256 KiB)**. The 151 MB file therefore costs one 256 KiB read. Those become a single
optional topic file `memory/session-history.md` (`kind: reference`, on demand) with one line per session.
Bodies, tool results and sub-agent transcripts are never read.

### 4.3 Map (`parse/**`, and the import resolver)

Every parser is **tolerant and total**: it returns `{ok:false, error}` rather than throwing, so one malformed
file among 43 costs one `skip:parse-error` row and nothing else (§6 row 23).

| Parser | Handles | Quirks it must absorb |
| --- | --- | --- |
| `frontmatter.ts` | `---` on line 1 only; scalars, lists, **one** nesting level (`metadata:`) | booleans `true/false/yes/no/on/off/1/0`; quoted and unquoted strings; a broken block ⇒ body still imported with a warning |
| `markdown.ts` | BOM/CRLF/bidi normalisation; headings (≤ 5, ≤ 80 cells, redacted); fence and code-span map; `fenceExecutables`; `@import` resolution; HTML-comment stripping; normalised token set + Jaccard | `@path` inside a fence or span is **not** an import; block-level HTML comments are stripped (Claude's own rule) before hashing |
| `mdc.ts` | Cursor frontmatter + markdown | `globs:` may be a string or a list; `alwaysApply` may be a string `"true"` |
| `jsonc.ts` | `//`, `/* */`, trailing commas | string-aware scanner (a `//` inside a string is not a comment) |
| `toml.ts` | dotted paths as `{path: string[], value}` | quoted table keys: `[projects."/Users/x/y"]` must survive as one path segment |
| `jsonl.ts` | streaming, byte-capped, mixed record types | a truncated last line is dropped, not fatal |
| `sqlite.ts` | guarded stub | returns `skip:unsupported` whether or not a reader module exists — never a crash (§9.5) |

**Import resolution** (`@path`, `@file.md`, `@{file}`, `{file:p}`, `${file:p}`): resolved relative to the
**containing file**; confined to the root the source was found in; depth **4**; cycle-detected; code spans and
fences skipped; `isSecretBasename` / `isMentionDenied` targets refused. An unresolved reference is preserved
verbatim as `<!-- jevcode: unresolved @x (outside <root>) -->` so nothing is silently dropped.

### 4.4 Classify (`classify.ts`, `secrets.ts`, `questions.ts`)

#### 4.4.0 The five classes, and where "unknown" goes

Classification answers one question — *what is this?* — with five answers, and the **unknown** answer is
never a silent bucket: it is always a named `skip:*` action that appears in the report with its reason.

| Class | Means | Lands in | `PlanRow.class` | Typical actions |
| --- | --- | --- | --- | --- |
| **memory** | a standing instruction, convention, preference or learned note | `AGENTS.md`, `memory/`, `memory-local/`, `rules/` | `memory`, `rule` | `create`, `append`, `update`, `merge` |
| **workflow** | a reusable prompt or procedure a human invokes by name | `commands/` | `command` | `create` (inert, §2.6) |
| **config** | settings: models, servers, paths, permissions | `mcp.json`, report-only sections | `config`, `mcp` | `create`, `merge`, `suggest` |
| **secret** | a credential | **nowhere** (the 0600 store only, on TTY consent) | `secret` | `skip:secret`, or the credential prompt |
| **unknown** | everything the rules could not place | nowhere | the row keeps its source class | one of 14 `skip:*` reasons |

The 14 unknown reasons, each rendered with its count in `## Skipped`: `skip:self`, `skip:unrelated`,
`skip:unsupported`, `skip:oversize`, `skip:not-text`, `skip:not-a-file`, `skip:parse-error`, `skip:symlink`,
`skip:transcript`, `skip:third-party`, `skip:tool-managed`, `skip:unknown-format`, `skip:remote`,
`skip:untrusted`. `--all` promotes `skip:unrelated` rows to reviewable so a human who disagrees with the
classifier can override it without editing anything.

A single file routinely produces rows in **three** classes at once (§0 principle 5); the classifier therefore
runs per *artefact-key*, not per file, and the report groups by destination rather than by source.

#### 4.4.1 File-class rules — total, deterministic, ordered

First match wins. `p` is the code rule's own confidence and is used **only** to decide whether the row is in
the band.

**Amended 2026-09-22** (review `docs/research/import/review-engine-2026-09-22.md` defect 11): the five *identity*
rules run **before** the atlas class. Every discovered artefact has an atlas row, so with the atlas class first the
identity verdicts were unreachable and the repo's own `AGENTS.md` — a destination — would have been classified as a
source and appended to itself on every run. The order below is normative; the previous order (atlas class as rule 1)
is withdrawn.

| # | Rule | Verdict | `p` |
| --- | --- | --- | --- |
| 1 | basename matches a destination name, or realpath ∈ destinations | `skip:self` | 1.0 |
| 2 | `isSecretBasename(name)` | SECRET (named, not read) | 1.0 |
| 3 | bytes > `sourceReadCapBytes` (4 MiB) | `skip:oversize` | 1.0 |
| 4 | not valid UTF-8 after BOM strip, or contains a NUL in the first 8 KiB | `skip:not-text` | 1.0 |
| 5 | format ∈ {js, sh, sqlite} | `skip:unsupported` | 1.0 |
| 6 | the atlas row declares a class and the parse succeeded | that class | 1.0 |
| 7 | frontmatter has `paths` / `globs` / `applyTo` / `trigger` / `alwaysApply` | MEMORY/rule | 0.95 |
| 8 | frontmatter has `argument-hint` / `arguments` / `allowed-tools` / `mode` / `template` / `prompt`, **or** the body contains `$ARGUMENTS` / `$1` | WORKFLOW | 0.90 |
| 9 | frontmatter has `name` + `description` and (`metadata.type` or `type`) | MEMORY/learned | 0.90 |
| 10 | markdown, ≥ 1 heading, ≤ 2 000 lines, no `$ARGUMENTS` | MEMORY | 0.75 |
| 11 | markdown, no heading, ≤ 200 lines | MEMORY | **0.55** → band |
| 12 | anything else | `skip:unrelated` | **0.45** → band |

**Band: `0.5 ≤ p < 0.7`.** Only rows 11 and 12 fall in it. Jev question group II is asked for exactly those.

#### 4.4.2 Config-key rules — per **key**, not per file

Walked over the parsed object with a dotted path; first match wins.

| # | Key predicate | Class |
| --- | --- | --- |
| 1 | path ∈ the known-secret set: `env.*` where `SECRET_NAME_RE` matches, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `oauthAccount.*`, `provider.*.options.apiKey`, `*.oauth.clientSecret`, `*-api-key`, `headers.Authorization`, `headers.x-api-key` | **SECRET** |
| 2 | `SECRET_NAME_RE.test(leafName)` (`/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i`, `redact.ts:56`) **and** the value is a string ≥ `MIN_SECRET_LENGTH` (8, `:53`) | **SECRET** |
| 3 | `detectSecrets(value).length > 0` — all 15 families (`redact.ts:429`) | **SECRET** |
| 4 | the value is a pure `${VAR}` / `{env:VAR}` / `$VAR` / `%VAR%` / `env_key` / `bearer_token_env_var` reference | CONFIG (reference only) |
| 5 | path ∈ the permission set: `permissions.*`, `allowedTools`, `permission.*`, `sandbox.*`, `approval_policy`, `sandbox_mode`, `trust_level`, `trust`, `hasTrustDialogAccepted`, `prefix_rule` | CONFIG/permission → **suggestion only** |
| 6 | path ∈ the hook/exec set: `hooks.*`, `notify`, `statusLine`, `*.command` outside `mcpServers` | WORKFLOW/exec → **report only** |
| 7 | path ∈ the mcp set: `mcpServers.*`, `mcp.*`, `mcp_servers.*`, `servers.*`, `context_servers.*` | CONFIG/mcp |
| 8 | value length ≥ 20, charset ∈ {hex, base64url, alnum}, Shannon entropy ≥ 3.2 bits/char, and the leaf name is **not** in the non-secret allowlist (`sha`, `sha256`, `hash`, `id`, `uuid`, `machineID`, `sessionId`, `checksum`, `etag`, `version`, `commit`, `digest`, `fingerprint`) | **band** → Jev group I |
| 9 | otherwise | CONFIG |

Rule 3 runs **before** the band, so anything a pattern recognises is a secret without asking anyone. Rule 8's
allowlist is what keeps a 64-hex `sha256` out of the band — and JevCode writes `sha256` fields itself, so the
allowlist is not hypothetical.

#### 4.4.3 The five Jev question groups

All built with `src/jev/questions.ts` — `noul` (`:37`), `choice` (`:63`), `score` (`:78`), `pairedNouls`
(`:87`), `ref` (`:110`) — so the REPORT rules hold: a definition plus ≥ 2 examples on **both** sides of every
Noul, an escape option (`ESCAPE_KEY`, `:8`) and a paired `can_` Noul (`PAIRED_PREFIX`, `:9`) on every Choice,
2–10 situation levels on every Score. One `Decider.ask` per group; groups I+II+III share one request when all
three are non-empty and the batch is ≤ `jevQuestions` (400); `assertQuestionBatch` (`:102`) is the backstop.

**Group I — `is_secret`** (band: key rule 8). State carries, per candidate:
`{ name, path, leaf, length, charset, entropyBucket, family, fileClass }` — **no value bytes, no substring,
not even a prefix.**

```
Noul  secret_<i>
instructions: Is the value stored at `candidates[<i>].path` a credential — an API key,
              token, password or private key?
true:  definition: the value is a secret a service accepts as proof of identity, and publishing
                   it would let someone else act as this user
       examples:   ["a 51-character alphanumeric value at env.ANTHROPIC_API_KEY",
                    "a 64-character hex value at mcpServers.github.env.GITHUB_TOKEN",
                    "a 40-character base64url value at headers.Authorization"]
false: definition: the value identifies, configures or describes something and is safe to publish
       examples:   ["a 64-character hex value at instructions[0].sha256",
                    "a 36-character uuid at projects.machineID",
                    "the string ${OPENROUTER_API_KEY} at mcpServers.x.env.OPENROUTER_API_KEY",
                    "the value z-ai/glm-5.3-flash at model"]
```

Decision: `secret ⟺ (code rule 1–3 fired) OR (in band AND p ≥ 0.5)`. **Jev may promote into the secret class
and may never demote out of it.** Fallback with no Jev: every band item is a secret.

**Group II — `file_kind`** (band: file rule `p ∈ [0.5, 0.7)`). State carries
`{ path, bytes, lines, fences, frontmatterKeys, headings }`, where `headings` appears only under
`--jev-sample=headings` (default) or `head400`, always through the session redactor **and** `patternRedact`,
each clipped to 80 cells, ≤ 5 per file.

```
Choice  kind_<i>
instructions: What is the file at `files[<i>].path`?
options:
  instructions_for_an_agent      a standing instruction, convention or preference an agent should
                                 follow while working in this project
  saved_workflow_or_command      a reusable prompt or procedure a human invokes by name, usually
                                 with arguments
  tool_configuration             settings for a tool: models, paths, servers, permissions
  conversation_log_or_transcript a record of what was said or done, written by a tool
  unrelated_project_file         source, documentation or data that belongs to the project and is
                                 not about how an agent should behave
  none_of_these                  (escape)
+ paired can_<option> Nouls, definition + 3 examples each side
```

Decision: `p ≥ 0.6` **and** its paired Noul ≥ `PAIRED_NOUL_FLOOR` (0.5, `loop/stages/choose.ts:10`) → that
kind; anything weaker → the code rule's verdict (row 11 → MEMORY, row 12 → `skip:unrelated`). This is exactly
the intake idiom (`chat/intake.ts:166,214`), so the codebase has **one** confidence convention, not two.

**Group III — `same_meaning`** (band: normalised-token Jaccard ∈ [0.6, 0.9)). State carries, per pair: both
paths, tools, byte counts, sha256 prefixes, heading lists, the Jaccard value and the longest common heading
run. Never bodies. Decision: identical normalised sha256 → same (no Jev); Jaccard ≥ 0.9 → same (no Jev);
< 0.6 → different (no Jev); in band → Jev `p ≥ 0.6` → same. Fallback: **keep both**, and the report says
`duplicate not resolved (jev unavailable) — both imported`. Normalisation before hashing/tokenising: strip
block-level HTML comments, strip frontmatter, collapse whitespace, lowercase, drop markdown punctuation, drop
`@import` lines already inlined.

**Group IV — `matters_here`** (asked only when the plan exceeds `memoryIndexLines`).

```
Score  rank_<i>   (5 levels, situations)
instructions: How likely is the note at `notes[<i>].path` to change what an agent does in
              `workspace` this week?
levels: ["it names a file, command or rule in this repository that an agent would otherwise get wrong",
         "it states a durable preference about how work is done here",
         "it records the state of a branch or task that is still open",
         "it records something that happened and is now finished",
         "it is about a different project, or about a tool that is not installed"]
```

Decision: the index holds the top N by level, ties broken by the code order. Code fallback order: `scope`
(project > project-local > user) → `kind` (project > rule > preference > feedback > reference) → `modified`
desc → bytes asc. **The Score only orders the index; it never drops a note** — everything not indexed is
still written as an on-demand topic file.

**Group V — `contradicts`** (band: Jaccard ∈ [0.3, 0.9) **and** opposed polarity markers on a shared object).
Code precondition, with no Jev call without it: both items contain an imperative about the same noun phrase,
one carrying a positive marker (`always`, `must`, `use`, `prefer`) and the other a negative one (`never`,
`don't`, `avoid`, `do not`).

**[G2.4] The payload is the headings, the matched noun phrase and the two polarity markers — not the two
sentences.** The spine sent two 200-char sentences, which is the only path in the design that bends *"Jev
never receives a file body"*, and pattern redaction cannot catch a secret written in prose. Since Jev's effect
here is limited to **ordering** the conflicts section (the verdict is `review` either way), the weaker payload
costs nothing real. `--jev-sample=none` suppresses group V entirely; under `head400` the two sentences may be
sent, redacted and clipped to 200 chars, and the report says so explicitly:
`jev: group V sent 2 sentence fragments (--jev-sample=head400)`.

Decision: `p ≥ 0.5` → the pair's action becomes `review`, and both rows are held back from apply until
answered. Fallback: `review` anyway.

#### 4.4.4 Cost

Worst realistic case on this machine: 43 topic files (0 in band, all matched by rule 9), ~60 config keys with
~6 in band, 1 duplicate pair in band, 0 conflicts. One request, ~70 questions, ~6 000 input tokens at
`JEV_INPUT_USD_PER_TOKEN = 4.2e-8` (`jev/types.ts:19`) ⇒ **$0.00025**. Report line:
`jev: 1 request · 70 questions · $0.0003 · 6 code fallbacks`. Hard cap `import.jevMaxUsd`, default `$0.01`;
exceeding it stops asking and takes fallbacks with a notice — it does not fail the import.

### 4.5 Conflicts, duplicates and the budget (`plan.ts`)

Four passes, in order, each bounded:

1. **Exact dedupe.** Group by normalised sha256. One row, `tools` unioned, no Jev.
2. **Near dedupe.** Jaccard over normalised token sets. **[G1.6]** Candidates are pre-bucketed by a 64-bit
   minhash band (fallback: first heading) so comparisons stay within buckets; the total is capped at
   `dedupePairs: 20 000` with `notice: duplicate scan capped at 20,000 pairs (N candidates)`. Without the
   bucketing an all-pairs pass at the declared `planRows: 2 000` ceiling is ~2 M token-set intersections,
   which is the only super-linear step in the engine.
3. **Conflicts.** The polarity precondition of group V, then Jev ordering. A conflict group's rows are
   `review` and are **excluded from `--yes`**.
4. **Budget.** Rank the index (group IV or the code order), trim to `memoryIndexLines`, write the remainder
   as on-demand topic files, emit `43 notes → 9 indexed, 34 on demand (512 KiB budget)`.

### 4.6 The dry-run report

#### 4.6.1 Plan shape

```ts
interface PlanRow {
  id: string;                       // stable: sha256(source.id + dest)[0..12]
  source: { id: string; display: string; tools: readonly SourceTool[]; sha256: string; bytes: number; mtimeMs: number };
  class: 'memory'|'rule'|'command'|'mcp'|'config'|'secret'|'transcript';
  dest: string | null;              // repo- or ~-relative; null for report-only rows
  action: 'create'|'append'|'update'|'merge'|'review'
        | 'skip:unchanged'|'skip:self'|'skip:secret'|'skip:executable'|'skip:unsupported'
        | 'skip:oversize'|'skip:not-text'|'skip:not-a-file'|'skip:parse-error'|'skip:symlink'
        | 'skip:transcript'|'skip:third-party'|'skip:tool-managed'|'skip:unknown-format'
        | 'skip:remote'|'skip:unrelated'|'skip:untrusted'
        | 'suggest';                // permissions & hooks: shown, never written
  scope: 'user'|'project'|'project-local';
  bytes: number;                    // destination bytes this row would write
  why: string;                      // `rule 9 (frontmatter name+description+metadata.type)`
                                    // | `jev kind_3 instructions_for_an_agent p=0.82 can_=0.71`
                                    // | `code fallback (jev unavailable: HTTP 429)`
  warnings: readonly string[];      // `2 shell segments fenced`, `1 value redacted`, `clipped 12,000 → 4,096 bytes`
  group?: string;                   // conflict / duplicate group id
}

interface ImportPlan {
  v: 1; importId: string; at: string; jevcodeVersion: string;
  workspace: string; workspaceKey: string;          // realpath(gitRoot ?? workspace) [G1.3]
  gitRoot: string | null; trust: 'trust'|'session'|'none';
  roots: readonly { display: string; tool: SourceTool; via: 'default'|'env'; env?: string; exists: boolean }[];
  rows: readonly PlanRow[];
  budget: { memoryBytes: number; memoryMax: number; indexLines: number; indexMax: number };
  jev: { requests: number; questions: number; usd: number; fallbacks: number; reason?: string };
  cannotRead: readonly { what: string; why: string; paste: string }[];
  notices: readonly string[];
}
```

`PlanRow` has **no field that can hold a value** — that is the structural half of §1 property 4; the leak gate
is the other half.

#### 4.6.2 `report.md`

Written to `~/.jevcode/imports/<importId>/report.md`, mode 0600 (§2.2).

```markdown
# jevcode import — dry run imp_20260921T120000Z_a1b2c3
2026-09-21T12:00:00.000Z · jevcode 0.9.0 · workspace /Users/…/JevCode (git root, trusted)
Nothing outside ~/.jevcode/imports/imp_20260921T120000Z_a1b2c3/ has been written.   ← [G2.6]

## Summary
41 to import · 9 to review · 137 skipped · 0 bytes of secrets copied
memory 38 KiB of 512 KiB · index 9 of 200 lines · jev 1 request, 70 questions, $0.0003, 6 fallbacks

## Sources
claude-code   ~/.claude                 (default)        168 artefacts
codex         ~/.codex                  CODEX_HOME        14 artefacts
copilot       ~/.copilot                (default)          0 artefacts (no instructions dir)
cursor        —                         not installed
windsurf      —                         not installed
opencode      —                         not installed
gemini        —                         not installed
aider         —                         not installed

## Memory → .jevcode/memory  (29 rows, 26 KiB)
create  memory/project-jevcode.md        ~/.claude/projects/…/memory/project-jevcode.md   4.1 KiB  9f8e7d6c  rule 9
create  memory/feedback-max-parallel.md  ~/.claude/…/feedback-max-parallel-agents.md      1.3 KiB  1a2b3c4d  rule 9
create  AGENTS.md                        ~/.claude/CLAUDE.md                              (absent) —         skip:self
…

## Rules → .jevcode/rules  (0 rows)

## Commands → .jevcode/commands  (6 rows, 9 KiB)
skip    commands/review-agent.md         ~/.codex/skills/.system/review-agent/SKILL.md    skip:third-party (bundled)
…

## MCP → .jevcode/mcp.json  (3 servers, all disabled)
create  mcp.json  ← ~/.codex/config.toml [mcp_servers.*]
        chrome-devtools   stdio  npx …          env: (none)
        context7          http   …              env: CONTEXT7_API_KEY (name only; the source held a literal)
        …

## Review  (9 rows)
conflict  memory/terse-diffs.md vs AGENTS.md:41
          "always explain before patching"   (~/.claude/CLAUDE.md)
          "never write prose before a patch" (~/.codex/AGENTS.md)
          1 keep both · 2 keep claude-code · 3 keep codex · 4 skip both
duplicate memory/agents-md.md ≈ AGENTS.md  (jaccard 0.78, jev same_meaning p=0.41 → both kept)
…

## Suggested permissions (not applied)
~/.claude/settings.json      permissions.allow   12 entries
~/.codex/rules/default.rules prefix_rule          8 allow entries
~/.codex/config.toml         projects."…"         trust_level = trusted  ×6
  JevCode's sandbox is set by --sandbox and /trust; nothing here was copied.

## Credentials  (4 found · 0 copied)
~/.claude/settings.json      env.ANTHROPIC_API_KEY   sha256:3f2a…   → offer: generator key (anthropic)
~/.claude.json               oauthAccount.token      (not read)
~/.claude/.credentials.json  (not read)
~/.codex/auth.json           (not read)
  Run `jevcode import --yes` on a terminal to be asked per key. Values never appear here.

## Cannot be read from disk  (3)
Cursor User Rules          stored on your Cursor account    → /memory add, or jevcode import --from -
Windsurf Cascade memories  undocumented local format        → /memory add
Codex memories             [features] memories = false      → enable, use Codex once, re-run import

## Skipped  (137)
skip:transcript     3 371  ~/.claude/projects/**/*.jsonl (2.7 GB) — jevcode import --source claude-transcripts
skip:unsupported       24  .claude/workflows/*.js, state_5.sqlite, …
skip:self               2  JevCode/AGENTS.md (absent), ~/.config/jevcode/AGENTS.md (absent)
…

## Notices
walk: ~/.claude/projects stopped at 20,000 entries (3 rows may be missing)
clip: .devin/rules/style.md clipped 12,000 → 4,096 bytes

## Apply
jevcode import --yes                              everything above except review and skip rows
jevcode import --yes --scope=user                 user-scope rows only
jevcode import --undo imp_20260921T120000Z_a1b2c3
```

`--json` emits the `ImportPlan` object on stdout: one object, no prose, no ANSI, no secrets.

### 4.7 Apply (`apply.ts` + the CLI's write seams)

#### 4.7.1 Preconditions

1. **Trust.** Project-scope rows require the workspace trust decision to be `trust` or `session`
   (`evaluateTrust`, `trust.ts:119`). Under `none`, project rows become `skip:untrusted` with
   `run /trust, then /import again`; user-scope rows still apply. `--trust-workspace`
   (`trustWorkspaceFlag`, `trust.ts:70`) counts.
2. **Idle.** `/import` **apply** is `availableDuringTask: 'idle'`; during a live run the dispatcher answers
   with the existing string, reused verbatim: `error: /import runs when the run is idle; Esc pauses first`
   (`registry.ts:600`). A **dry run** is `any`.
3. **Lock.** `~/.jevcode/imports/.lock`, created `O_EXCL` with `{pid, importId, op, at}`. **[G1.4] The lock
   covers every mutating operation — `apply`, `--resume` *and* `--undo`** — because all three rewrite
   `apply.jsonl` and the manifest. Stale when the pid is gone or the entry is older than 10 minutes; taken
   over with `notice: replaced a stale import lock (pid 1234 gone)`. A second mutator prints
   `an import is applying (pid 1234, 14 s ago) — try again when it finishes` and exits 2.

#### 4.7.2 Source re-verification — the plan is what gets applied **[G1.1]**

`PlanRow` carries no body, so apply **must** re-read each source to render its destination. The spine recorded
`source.sha256` but never re-checked it, which makes "sha256-pinned" advisory rather than true and leaves the
hostile-repo window of §A.3 open: a source edited (or swapped) between the report and `y` would be written
silently, under a marker recording the *plan's* sha.

**Rule.** Immediately before rendering each row, re-`stat` and re-hash the source. Require
`sha256 === row.source.sha256`. On mismatch the row is demoted, nothing is written for it, and the report/item
says:

```
review — source changed since the plan (9f8e7d6c → 1a2b3c4d); nothing was written
```

`mtimeMs` is carried in `PlanRow.source` purely as a cheap pre-filter: unchanged mtime **and** unchanged size
skips the re-hash; anything else re-hashes. Exit code becomes 2 when any row was demoted this way, and the
item names the resume command. Gate: `import-source-toctou.test.ts`.

#### 4.7.3 Destination confinement **[G1.2]**

Destination names come from source-controlled frontmatter `name:` and source filenames. The spine's
invariant 6 covered `@import` traversal *inside bodies* and said nothing about the destination path; the repo
has no slug helper today; and `writeFileAtomic` (`atomic.ts:19`) has no `O_NOFOLLOW` and creates parents with
`{mkdir: true}`. So `name: ../../.git/hooks/pre-commit` in a cloned repo's `.cursor/rules/*.mdc` would escape
the destination tree and land an executable file.

Three mandatory steps, all in the engine, asserted again at the seam:

```ts
// src/import/plan.ts
export function slugOf(name: string, fallbackSeed: string): string {
  const s = name.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== '.' && s !== '..'
    ? s : sha256Hex(fallbackSeed).slice(0, 8);      // hash.ts:12
}
```

1. **Sanitise** every destination basename through `slugOf(name, realpath)`. Empty, `.`, `..`, pure-punctuation
   and over-long names all fall back to `sha256(realpath)[0..8]`.
2. **Confine**: assert `isInside(resolve(dest), destinationRoot)` immediately before the write — the same
   `isInside` guard `instructions.ts:69` already uses for reads.
3. **Refuse a symlinked final component**: `lstat` the target; if it is a symlink, the row becomes
   `review — destination is a symlink; nothing was written`. (`writeFileAtomic` renames over the target, so a
   symlink would be replaced rather than followed — but a symlinked *parent* directory created by an earlier
   row is the real hazard, and `isInside(realpath(dirname(dest)))` catches it.)

Gate: `import-slug-escape.test.ts`, four hostile names plus a symlinked destination; `.git/hooks` untouched.

#### 4.7.4 Order (it matters)

1. `pre/` snapshots of every existing destination a row touches — byte-for-byte, with modes.
2. **Credential rows**, so `config.addSecret` registers the value in the `SecretSet` **before** anything can
   print it — the ordering `persistCredentials` already uses (`session.ts:1573-1580`).
3. `memory/<slug>.md`, `memory-local/<slug>.md`, `rules/<slug>.md`, `commands/<n>.md` — independent, atomic
   per file.
4. `memory/MEMORY.md` — needs every topic file's final slug and summary.
5. `mcp.json` — merge: existing servers untouched, new ones added `enabled: false`, name collision →
   `<name>-<tool>`.
6. `AGENTS.md` appends — **last**, because the trust pin is recomputed after.
7. `apply.jsonl`: one line per item `{row, dest, sha256Before, sha256After, mode, bytes, at, ok, error?}`,
   appended **after** each write, so a crash resumes.
8. Manifest merge (`~/.config/jevcode/imports.json`).
9. Trust re-pin (§4.7.5).

Every write is `writeFileAtomic(path, text, { mode, mkdir: true })` — 0644 for workspace files, 0600 for
`memory-local/**` and everything under the config dir — followed by the `chmod` policy `writeJsonSecure`
(`credentials.ts:180`) already applies. A failure on one row is recorded and the loop continues; the command
exits `EXIT_CODES.config` (2, `errors.ts:284`) if any row failed, 0 otherwise.

#### 4.7.5 Markers, idempotency and the re-run matrix

An append into an existing file is always wrapped:

```markdown
<!-- jevcode:import imp_20260921T120000Z_a1b2c3 source=claude-code:~/.claude/CLAUDE.md sha256=9f8e7d6c -->
…imported text…
<!-- /jevcode:import imp_20260921T120000Z_a1b2c3 -->
```

Marker lines are block-level HTML comments, which Claude Code strips when loading — so a `CLAUDE.md` JevCode
appended to stays clean for the other tool too.

| Manifest entry | Source sha256 | Markers | Destination | Action |
| --- | --- | --- | --- | --- |
| yes | unchanged | present | unchanged | `skip:unchanged` (0 bytes) |
| yes | changed | present | unchanged | `update` — replace between the markers, new sha in the marker |
| yes | unchanged | present | changed **outside** the block | `skip:unchanged` |
| yes | unchanged | present | changed **inside** the block | `review` — "the block was edited; nothing was written" |
| yes | any | **missing** | exists | `review` — "the block was edited or removed; nothing was written" |
| yes | any | — | **absent** | **`create`** — `notice: destination was removed since imp_…; re-creating` **[G1.3]** |
| no | — | present (another import) | — | `merge` — a second marker block appended below |
| no | — | absent | exists | `append` |
| no | — | — | absent | `create` |

Row 6 is the cell the spine left undefined; without it a deleted destination is skipped forever.

**[G1.3] The manifest is keyed by workspace.** `ImportManifest` is
`{ v: 1, user: Entry[], workspaces: Record<workspaceKey, Entry[]> }` with
`workspaceKey = realpath(gitRoot ?? workspace)`. A single global list against repo-relative destinations makes
a second clone of the same repo look already-imported. Gate: `import-twice.test.ts` gains a second clone at a
different path (expects full `create` rows) and a deleted destination (expects `create`, not
`skip:unchanged`).

**Trust re-pin [G1.5].** Appending to `AGENTS.md` changes its sha256, which `evaluateTrust` treats as
`{kind:'prompt', reason:'changed'}` at the next start (`trust.ts:126-129`). Re-prompting about a change the
human just approved is noise; silently re-pinning is a hole. Rule:

> Re-pin only when (a) the stored decision is `trust`, and (b) the new bytes can be **reconstructed** from the
> old bytes plus exactly the marker-delimited edits this apply performed — for an `append`, old + the blocks;
> **for an `update`, old with each named block's interior replaced** and every byte outside the blocks
> identical. Verified by reconstruction, never by diffing prose.

The spine's rule covered only `append`, so every changed-source re-import would have re-prompted — safe, but a
silent degradation that nobody would have connected to the importer. Items:

```
[import] trust: AGENTS.md re-pinned (sha256 1a2b3c4d → 9f8e7d6c) — the block you approved
[import] trust: AGENTS.md changed outside the import block — you will be asked once at the next start
```

Gate: `trust.test.ts` gains marker-internal replace ⇒ re-pinned, and one byte changed outside ⇒ not re-pinned.

#### 4.7.6 Undo, resume, retention

- **`--undo <id>`** takes the lock **[G1.4]**. For each `apply.jsonl` row: if the destination's current sha256
  equals `sha256After`, restore from `pre/` (or delete, for a `create`), restoring the mode; otherwise
  `review — modified since the import; left alone`. **A missing pre-image is a row outcome, not an
  exception**: `review — pre-image unavailable (~/.jevcode/imports/<id>/pre removed); left alone` **[G1.4]**.
  Manifest entries are removed only for rows actually restored. A credential is never touched by undo —
  `jevcode logout` (`removeCredentials`, `credentials.ts:305`) already removes keys, and undoing a key the
  human then started using would break the next run.
- **`--resume <id>`** re-reads `plan.json`, skips every row already `ok: true` in `apply.jsonl`, re-verifies
  each remaining source (§4.7.2), and continues. This is also what `Ctrl-C` during apply prints:
  `applied 9 of 41 — jevcode import --resume imp_…`, exit 130.
- **Retention [G1.4].** `importsKeep: 10` newest import dirs; the rest are GC'd at the **start** of the next
  import with `notice: removed 3 old import records (kept the newest 10)`. An id still referenced by a
  manifest entry that has not been undone is **never** GC'd, because its `pre/` is the undo source. Without
  this the `pre/` snapshots grow without bound beside a 3 GB `~/.claude`.

### 4.8 Secrets are never imported

#### 4.8.1 The six invariants

1. **A credential value never reaches** `report.md`, `plan.json`, `sources.jsonl`, `apply.jsonl`, a Jev
   request, `~/.jevcode/sessions/index.jsonl`, `~/.jevcode/history.jsonl`, a toast, a log line, or an imported
   destination. Enforced structurally (no type carries a value) **and** by the leak gate.
2. **A credential value is read at most twice**: once to fingerprint and classify, once to hand to
   `config.addSecret` + `writeCredentials` after an explicit TTY `1`. The reader returns
   `{name, fingerprint, shape}`; no buffer is retained.
3. **Imported text is redacted at write time** (§2.9).
4. **Nothing imported widens JevCode's authority** (§1 property 16).
5. **Nothing imported can execute** (§2.6).
6. **Path traversal cannot escape** — for reads (§4.3) *and* for writes (§4.7.3 **[G1.2]**).

#### 4.8.2 Consent

Only the human's own TTY confirmation, or their own `--yes`, authorises a write. The manifest records
`by: 'tty' | 'flag'` per run. `--yes` from a non-TTY applies M/W/C rows and **refuses every credential row**:

```
credentials need a terminal — run jevcode import on a tty, or set the variable yourself
```

Only the credentials JevCode itself uses (`CREDENTIAL_KEYS = ['apiKey','jevApiKey']`, `credentials.ts:26`) are
ever *offered*; every other secret is reported by name and left where it is.

#### 4.8.3 What travels instead of a secret

An env-var **name** and a `${VAR}` reference. `env: {GITHUB_TOKEN: "ghp_…"}` becomes
`env: {GITHUB_TOKEN: "${GITHUB_TOKEN}"}` plus the note *"the source held a literal value; only the name was
imported"*. A `headers.Authorization: "Bearer sk-…"` becomes `${MCP_<SERVER>_AUTH}` with the same note.

#### 4.8.4 Permissions and hooks

Never written. `permissions.*`, `allowedTools`, `prefix_rule(...)`, `trust_level`, `sandbox_mode`,
`approval_policy`, `trust`, `hasTrustDialogAccepted` land in `## Suggested permissions (not applied)`, whose
closing line names the two things that *do* set JevCode's authority: `--sandbox` and `/trust`. `hooks`,
`notify`, `statusLine` and `.js` workflows are report-only. Gate: `import-authority.test.ts` asserts **zero**
bytes of these classes were written.

### 4.9 Degradation matrix

| Condition | Behaviour | Exit |
| --- | --- | --- |
| no tool installed | full report, empty sections, `## Cannot be read from disk` still rendered | 0 |
| Jev 401 / 402 / 429 / timeout / `--no-jev` / `--mock` | complete plan from code fallbacks; `jev: not asked (<reason>)` | 0 |
| `import.jevMaxUsd` exceeded mid-batch | stop asking, fallbacks, notice | 0 |
| one file unparsable | one `skip:parse-error` row | 0 |
| one root unreadable (EACCES) | `notice: cannot read <root>: EACCES`; other roots scanned | 0 |
| walk cap hit | rows found so far + notice | 0 |
| workspace untrusted | project rows `skip:untrusted`; user rows apply | 0 |
| source changed since the plan **[G1.1]** | that row `review`, others apply | 2 |
| destination write fails (EACCES/ENOSPC) | that row fails, others apply, error item | 2 |
| lock held **[G1.4]** | refuse with pid + age | 2 |
| SIGINT during discover | nothing written, `[import] cancelled` | 130 |
| SIGINT during apply | current file finishes, resume command printed | 130 |
| `--scope=project` with no git root | refuse with the reason | 2 |

---

## §5 The onboarding prompt — copy and flow

Every string below is final copy, written to the existing conventions: sentence case, ` · ` separators, an
`--ascii` twin for every glyph (`asciiTwins`, `glyphs.ts:223`), a narrow twin whenever the wide form exceeds
the inner width, a screen-reader twin that numbers choices and ends `Enter selection (1-N):`, and a `--plain`
prompt twin. Cell widths are measured, not counted in characters. All of them live in **one file**,
`src/tui/import/lines.ts`, except the `[import]` item texts, which live in `src/config/imports.ts` and are
re-exported (principle 10).

### 5.1 The wizard step

`WizardStep` (`onboarding/reducer.ts:26`) gains `'import'` **between `'sandbox'` and `'done'`**.

**Gating.** Shown only when a **cheap probe** found something: a stat-only existence check of the nine home
roots plus a count of `~/.claude/projects/*/memory/*.md`, bounded at **50 ms**, run *after the first frame*
(F1 — no file I/O before frame 0, `config/launch.ts`) and after the sandbox step. Measured on this machine
today: the nine-root stat probe is ~1 ms and the memory glob ~15 ms warm. If the probe finds nothing, the step
does not render and the flow stays `sandbox → done` (§6 row 73).

**Three rows, inside the ≤ 4-row budget (D1):**

```
Import your memory and workflows?  found claude-code (43 notes), codex (3 servers)
  1 import now   2 later (/import)   3 never
Nothing is written until you approve it · Esc later · Ctrl-C closes
```

| Constant | Text | Cells |
| --- | --- | --- |
| `WIZARD_IMPORT_TITLE` | `Import your memory and workflows?` + `  found <summary>` at render time | 33 + summary |
| `WIZARD_IMPORT_TITLE_NARROW` | `Import your memory and workflows?` | 33 |
| `WIZARD_IMPORT_OPTIONS` | `  1 import now   2 later (/import)   3 never` | 44 |
| `WIZARD_IMPORT_OPTIONS_NARROW` | `  1 import   2 later   3 never` | 30 |
| `WIZARD_IMPORT_HINT` | `Nothing is written until you approve it · Esc later · Ctrl-C closes` | 67 |
| `WIZARD_IMPORT_HINT_NARROW` | `Nothing is written yet · Esc later` | 34 |
| `SR_IMPORT_ROWS` | `Import your memory and workflows?` / `Found claude-code, 43 notes. Codex, 3 servers.` / `1. Import now  2. Later, with slash import  3. Never · Enter selection (1-3):` | ≤ 76 each |

The probe summary is built from counts and tool names only (F-O: sources, counts, fingerprints — never a
value, never a body): `found claude-code (43 notes), codex (3 servers)`, or with one tool
`found claude-code (43 notes)`, or `found 4 tools (61 items)` when the list would not fit.

**Behaviour.**

| Key | Effect |
| --- | --- |
| `1` | closes the wizard and opens the **import overlay** (§5.2). Not nested wizard rows: the wizard owns ≤ 4 rows and a 41-row report cannot live there. |
| `2` | `seen.import = "<jevcode version>"` through `writeConfigValue` (`credentials.ts:328`) — the offer prints once per version, not once per launch |
| `3` | `seen.import = "never"` — the established one-time pattern of `seen.defaultMode` (`defaults.ts:154`, D-Q) |
| `Esc` | same as `2` |
| `Ctrl-C` | closes the wizard; nothing written; never exits (`cancelCloses`) |

`WizardHost` gains `importProbe?(): Promise<ImportProbe>` and `openImport?(): void`; both optional, so a host
without them simply never shows the step.

### 5.2 The import overlay

`OverlayKind` (`layout.ts:52,55`) gains `'import'`; it joins `COLLAPSING` (`:58`) so a live run's panes take
priority; `overlayWant('import', …)` (`:87`) returns `min(12, rows − 8)` boxed / `min(10, rows − 6)` flat.
`OverlayData` (`Overlay.tsx:66`) gains `import?: { state: ImportUiState } | null`.

```ts
type ImportStep = 'scanning'|'groups'|'rows'|'conflict'|'credential'|'confirm'|'applying'|'done';
interface ImportUiState {
  step: ImportStep;
  groups: readonly { key: string; title: string; rows: number; bytes: number; on: boolean }[];
  cursor: number; expanded: string | null;
  rowOn: Readonly<Record<string, boolean>>;
  conflict: { group: string; option: 1|2|3|4|null } | null;
  credential: { name: string; source: string; fp8: string; option: 1|2|null } | null;
  applied: { ok: number; failed: number; total: number } | null;
  hint: string | null;
}
```

**[G2.5] The common path is one key.** The spine put eleven bindings and a 41-row grid into a 12-row
collapsing overlay — heavier than `/review` (`y`/`n`/`e`) or `/undo` (one row), and the review step is exactly
where a 190-artefact import would stall. The default view is therefore **five group rows and one key**:

```
Import — 41 to import · 9 to review · 137 skipped · 38 KiB           imp_…a1b2c3
  memory    29 rows  26 KiB   on
  rules      0 rows            —
  commands   6 rows   9 KiB   on
  mcp        3 servers         on   (disabled on arrival)
  review     9 rows            — needs you
[y] import all 41 · [Enter] open a group · [r] review 9 · [d] full report · [Esc] close
```

- **`y`** applies every non-`review`, non-`skip` row. That is the whole common path.
- **`Enter`** expands the group under the cursor into its rows; **`Space`** toggles the row or the group;
  `a` / `n` are all-on / all-off **inside the expanded group**; `d` opens the destination diff for the
  selected row (the span renderer of `src/tui/Review.tsx`, reused).
- **`r`** jumps to the review queue; `1`–`4` answer a conflict or credential prompt (digit highlights, same
  digit or `Enter` confirms — the `WIZARD_OPTIONS_ORDER` idiom, `reducer.ts:42`).
- **`Esc`** closes with nothing written. **`Ctrl-C`** closes (command-opened overlay: it never exits).
- The full 41-row grid lives in `report.md` and in `--plain`, where there is room for it.

Hints (all in `lines.ts`):

| Constant | Text |
| --- | --- |
| `IMPORT_HINT_GROUPS` | `[y] import all N · [Enter] open a group · [r] review N · [d] full report · [Esc] close` |
| `IMPORT_HINT_ROWS` | `Space toggles · a all · n none · d diff · Enter back · y import` |
| `IMPORT_HINT_PICK` | `pick 1–4 · Esc back` |
| `IMPORT_HINT_APPLYING` | `applying … Ctrl-C stops after the current file` |
| `IMPORT_HINT_NOTHING` | `nothing selected — Space turns a group on, or Esc to close` |
| `IMPORT_HINT_LOCKED` | `an import is applying (pid <p>, <n> s ago) — try again when it finishes` |
| `IMPORT_HINT_LIVE` | `error: /import runs when the run is idle; Esc pauses first` (reused verbatim, `registry.ts:600`) |

### 5.3 The conflict prompt

```
Conflict — two instructions disagree                                     1 of 9
  always explain before patching        ~/.claude/CLAUDE.md
  never write prose before a patch      ~/.codex/AGENTS.md
  1 keep both   2 keep claude-code   3 keep codex   4 skip both
pick 1–4 · Enter = keep both · Esc back
```

`Enter` with nothing chosen is **`1 keep both`** — nothing is lost, and the report already flagged the pair.
Conflict rows are never applied by `--yes`.

### 5.4 The credential prompt

```
Found a generator key in ~/.claude/settings.json (env.ANTHROPIC_API_KEY, sha256:3f2a…)
  1 save it as JevCode's code-model key   2 leave it where it is
pick 1–2 · Esc = leave it · the value is never shown or copied anywhere else
```

**One prompt per key, TTY only, never satisfied by `--yes`.** Only `apiKey` and `jevApiKey`
(`CREDENTIAL_KEYS`, `credentials.ts:26`) are ever offered. Accepting routes through
`config.addSecret` → `writeCredentials` (§4.7.4 step 2) and produces the existing
`keyEnteredText` / `savedText` items (`credentials.ts:36,45`), so an imported key is indistinguishable from a
pasted one from that point on.

### 5.5 `[import]` items

Built in `src/config/imports.ts`, re-exported by `src/tui/import/lines.ts`. Heads ≤ 60 cells, facts ≤ 240,
sentence case, ` · ` separators, money as `$0.0003` (TD3 §5.1).

```
[import] plan imp_20260921T120000Z_a1b2c3 · 41 to import · 9 to review · 137 skipped
[import] report ~/.jevcode/imports/imp_…/report.md (0600)
[import] jev 1 request · 70 questions · $0.0003 · 6 code fallbacks
[import] applied 41 of 41 · memory 29 · commands 6 · rules 0 · mcp 3 (disabled) · 38 KiB
[import] generator key: imported from ~/.claude/settings.json env.ANTHROPIC_API_KEY (sha256:3f2a…)
[import] trust: AGENTS.md re-pinned (sha256 1a2b3c4d → 9f8e7d6c) — the block you approved
[import] trust: AGENTS.md changed outside the import block — you will be asked once at the next start
[import] active from the next run · /new starts one here · rules and topics are live now
[import] 4 credentials found, 0 copied · values never leave their file
[import] skipped 3,371 transcripts (2.7 GB) — jevcode import --source claude-transcripts
[import] nothing found · 3 sources cannot be read from disk · /memory add pastes them
[import] undo imp_… · 41 files restored · 0 modified since
[import] source changed since the plan: ~/.claude/CLAUDE.md (9f8e7d6c → 1a2b3c4d) — not written
[import] error: could not write .jevcode/memory/MEMORY.md: EACCES (40 of 41 applied)
[import] cancelled · nothing was written
[import] applied 9 of 41 — jevcode import --resume imp_20260921T120000Z_a1b2c3
[import] removed 3 old import records (kept the newest 10)
```

### 5.6 The CLI twin

```
jevcode import [<source>…] [flags]
```

`Command` (`args.ts:19-20`) gains `'import'`; `ParsedFlags` gains
`importOp?: 'plan'|'apply'|'undo'|'resume'`, `importId?`, `importSources?`, `importFrom?` — the existing
`sessionsOp` idiom. Positionals are source names validated against the atlas: `claude`, `codex`, `opencode`,
`cursor`, `windsurf`, `aider`, `gemini`, `copilot`, `claude-desktop`, `mcp`, `claude-transcripts`,
`codex-sessions`, `opencode-sessions`, `aider-history`.

| Flag | Meaning |
| --- | --- |
| `--dry-run` | the default; explicit for scripts |
| `--yes` | apply every non-`review`, non-`skip` row; **never** a credential row |
| `--scope user\|project\|both` | default `both` |
| `--from <path>` | extra root (repeatable); `-` reads markdown from stdin |
| `--source <name>` | restrict to named sources (repeatable); the only way to enable a transcript pass |
| `--report <file>` | write `report.md` here too |
| `--undo <id>` / `--resume <id>` | §4.7.6 |
| `--jev-sample none\|headings\|head400` | what metadata reaches Jev (default `headings`) |
| `--no-jev` | code rules only |
| `--keep-raw` | keep verbatim copies of M/W sources under `raw/` (secret-scrubbed; never C or S sources) |
| `--all` | include `skip:unrelated` rows as reviewable |
| `--force` | ignore the manifest (re-import unchanged sources) |
| `--json` | `plan.json` on stdout |
| `--respect-gitignore` / `--no-respect-gitignore` | default on for repo roots |

**Exit codes** (`errors.ts:284`): `0` plan or clean apply · `2` (`config`) a usage error, a write failure, a
held lock, or any row demoted by the source re-check **[G1.1]** · `4` (`budget`) `import.jevMaxUsd` exceeded
while `--jev=strict` was given · `130` SIGINT during apply with rows left.

`jevcode report <run-id>` gains an `imports` section listing the manifest entries active for that run, so a
bench result stays reproducible when memory changes underneath it.

### 5.7 The five twins

| Twin | Behaviour |
| --- | --- |
| `--plain` | the full numbered report on stdout; `Enter selection (1-N):` prompts for groups, conflicts and credentials; identical strings from `lines.ts`; the readline composer's existing prompt idiom |
| `--screen-reader` | numbered lists, no bullets, counts spoken as words, no box drawing; `SR_IMPORT_ROWS` and the SR twins of every hint |
| `--ascii` | `->` for `→`, `-` for `·` and `—`, `...` for `…`, `>=` for `≥` — the `asciiTwins` map (`glyphs.ts:223`), applied to code-generated strings only, never to user text |
| pipe / `--no-input` | dry run only; the report path plus one summary line on stdout; exit 0; nothing applied. `--yes` in a pipe applies non-credential rows and refuses credentials with the §4.8.2 line |
| `--json` | one `ImportPlan` object, no prose, no ANSI, no secrets |

`--plain` shape:

```
jevcode import — dry run imp_20260921T120000Z_a1b2c3
Nothing outside ~/.jevcode/imports/imp_20260921T120000Z_a1b2c3/ has been written.

  1 memory     29 rows  26 KiB  [on]
  2 rules       0 rows          [--]
  3 commands    6 rows   9 KiB  [on]
  4 mcp         3 servers       [on]  (disabled on arrival)
  5 review      9 rows          [needs you]

  a import all 41 · number toggles a group · r review · f full report · q quit
Enter selection (1-5, a, r, f, q):
```

### 5.8 Commands

#### 5.8.1 Registry rows

| name | aliases | args | avail | plain | category | title |
| --- | --- | --- | --- | --- | --- | --- |
| `import` | `imp` | `[<source>]` (enum from the atlas, optional) | `idle` | `yes` | `config` | bring memory and workflows in from your other agents |
| `memory` | `mem` | `[list\|show\|add\|forget\|reload] [<slug>]` | `any` | `yes` | `config` | what JevCode remembers here, and how to change it |

Both aliases satisfy the §4.1 alias rules: `NAME_RE` tokens, unique across names **and** aliases
(`BY_NAME`, `registry.ts:557-564`), and neither command destroys state on a bare Enter, so the
one-letter-alias prohibition (D-K) does not apply. `POPULAR` (`registry.ts:86`, 16 entries) is **unchanged**:
`/import` is discovered from the wizard step and `/help`, not by displacing a popular row.

The table feeds the dispatcher, the palette, `/help`, `docs/COMMANDS.md`, `man/jevcode.1` and the three
completion files through `scripts/gen-docs.mjs` — so adding the two rows and re-running the generator is the
whole surface change, and the existing drift gate enforces that the generated files are committed.

#### 5.8.2 `/memory`

| Verb | Effect |
| --- | --- |
| `/memory` or `/memory list` | `9 notes indexed, 34 on demand · 6 rules · 6 commands · project + user` and the index lines |
| `/memory show <slug>` | prints the topic file, redacted, in the transcript |
| `/memory add` | multi-line composer draft → `memory/pasted-<ts>.md` (§3.11) |
| `/memory forget <slug>` | moves the file to `~/.jevcode/trash/` — **never** `unlink` |
| `/memory reload` | re-reads rules, topics and project commands; emits `reloaded 6 project commands, 6 rules` |

#### 5.8.3 The dynamic-command seam

`COMMANDS` is static and `BY_NAME` is built once at module load (`registry.ts:557`), consulted through the
single lookup `findCommand` (`:576`). Rather than make the table mutable, add a second **pure** layer in
`src/tui/commands/project.ts` (TUI-owned):

```ts
export interface ProjectCommand { name: string; description: string; argumentHint?: string; path: string; body: string }
export function projectCommandSpec(c: ProjectCommand): CommandSpec;      // category 'project', avail 'idle', plain 'yes'
export function resolveCommand(name: string, project: readonly ProjectCommand[]): CommandSpec | ProjectCommand | null;
```

`dispatch.ts` and `palette.ts` consult `findCommand` **first**, then the project list — a built-in always wins
a name collision, and the palette tags the project row `[project]` (A63). The list is loaded once per session
from `.jevcode/commands/` + `~/.config/jevcode/commands/` after the first frame, and reloaded by
`/memory reload`.

### 5.9 Settings

| name | flag | env | fileKey | default | hidden |
| --- | --- | --- | --- | --- | --- |
| `import.jevSample` | `--jev-sample` | `JEVCODE_IMPORT_JEV_SAMPLE` | `importJevSample` | `headings` | — |
| `import.jevMaxUsd` | — | `JEVCODE_IMPORT_JEV_MAX_USD` | `importJevMaxUsd` | `0.01` | — |
| `import.scope` | `--scope` | `JEVCODE_IMPORT_SCOPE` | `importScope` | `both` | — |
| `memory.enabled` | `--no-memory` (negate) | `JEVCODE_NO_MEMORY` (negateEnv) | `memory` | `true` | — |
| `memory.maxBytes` | — | `JEVCODE_MEMORY_MAX_BYTES` | `memoryMaxBytes` | `524288` | — |
| `seen.import` | — | (none) | `seenImport` | `null` | `true` |

Six `SettingName` members, six `SETTINGS` rows (`defaults.ts`), one enum check each for `jevSample` and
`scope` in `validate.ts`, and the USD validator reused for `jevMaxUsd`. `seen.import` is written only by the
session, never by a flag or a variable, and is hidden from `jevcode config` unless `--all` — exactly
`seen.defaultMode`'s contract (`defaults.ts:154`).

### 5.10 Session index

`INDEX_KINDS` (`session/index.ts:36`) gains `'import'`. The line body is `{importId, rows, bytes, tools}` —
counts only, no path — inside the existing ≤ 512-byte / `clip(oneLine(redact(x)), 60)` discipline.
`SessionRow` folds `imports?: number`.

---

## §6 Corner cases

**97 rows.** Owner in brackets. Every row names the expected behaviour, the point in the pipeline that detects
it, and the test that pins it. Rows marked **[G…]** exist because of a graft; rows marked **[new]** were added
for this document because the task named the case and the spine did not cover it.

### A. Discovery and roots (18)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 1 | `CLAUDE_CONFIG_DIR=/tmp/cc` | every Claude root resolves under it; `~/.claude` untouched; report shows `claude-code /tmp/cc CLAUDE_CONFIG_DIR` | `sources.ts rootFor` reads the override before the default | `discover.test.ts` [H] |
| 2 | `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | same per tool; the `via` column names the variable | one `rootFor(spec, env, home, platform)` | `discover.test.ts` [H] |
| 3 | `OPENCODE_DATA_DIR=/a,/b` | both roots scanned, deduped by realpath | split on `,`, trim, absolute-only | `discover.test.ts` [H] |
| 4 | relative `XDG_CONFIG_HOME=.config` | ignored per spec; falls back to `~/.config` | `xdgConfigHome` (`credentials.ts:60`) reused | `discover.test.ts` [H] |
| 5 | **nothing installed** | every section renders, incl. an empty `## Cannot be read from disk`; `[import] nothing found · 3 sources cannot be read from disk · /memory add pastes them`; exit 0 | `roots.every(r => !r.exists)` | `report.test.ts` [H] + pty `r4-import-empty` [T] |
| 6 | `JevCode/.claude/worktrees/` — **25 real checkouts, ~50 000 entries, 2 227 MB** | excluded before any `stat`; 0 duplicate `AGENTS.md` rows | exclusion list, before the walk | `discover.test.ts` (3 fake worktrees) [H] + the perf gate |
| 7 | `node_modules`, `.git`, `dist`, `coverage`, `build`, `target`, `vendor`, `.venv`, `__pycache__`, `.next` | excluded always, even under `--all` | same | `discover.test.ts` [H] |
| 8 | one `AGENTS.md` found by codex + opencode + copilot + cursor + claude | **one** `SourceItem`, `tools` length 5; report `· read by codex, opencode, copilot, cursor, claude-code` | realpath-keyed discovery | `discover-dedupe.test.ts` [H] |
| 9 | a source realpath equals a destination | `skip:self`; a file is never appended to itself | destination set built before classify | `plan.test.ts` [H] |
| 10 | `~/.claude/CLAUDE.md` symlinked to `~/notes/claude.md` (inside `$HOME`, outside `~/.claude`) | `skip:symlink — resolves outside ~/.claude` | `realpath` + `isInside(root)`, the `instructions.ts:118-124` policy | `discover.test.ts` [H] |
| 11 | a root dir symlinked to `$HOME` (walk loop) | visited `dev:ino` set breaks it; `notice: <root> walk stopped (cycle)` | inode set | `discover.test.ts` [H] |
| 12 | **EACCES** on `~/.claude/projects` | `notice: cannot read ~/.claude/projects: EACCES`; every other root still scanned; exit 0 | per-dir try/catch returning the errno | `discover.test.ts` [H] |
| 13 | a FIFO, socket, device or directory where a file is expected | `skip:not-a-file`; never opened | `stat().isFile()` before `open` | `discover.test.ts` [H] |
| 14 | **3 371 transcripts, 2.7 GB, largest 151 MB** | `skip:transcript`, bytes reported, never read; with `--source claude-transcripts` a 256 KiB stream parse per file yields one metadata line each | `transcriptScanBytes` | `discover.test.ts` + perf gate [H] |
| 15 | Claude slug `-Users-…-JevCode--claude-worktrees-llm-jev-int` (not reversible) | resolved via `~/.claude.json` `projects` keys → a transcript `cwd` → `unmapped (pick a path)`; worktree slugs merged into the resolved repo root with a notice | `slugToPath(slug, claudeJson, transcriptCwd)` | `slug.test.ts`, the three real slug shapes [H] |
| 16 | case sensitivity: `claude.md` beside `CLAUDE.md` **[G1.6]** | decided by a **per-volume probe** (write-and-stat a temp name once per root, cached), not by `platform`: case-insensitive volume → one row with the on-disk name; case-sensitive volume (incl. a case-sensitive APFS volume on macOS) → two rows | `volumeIsCaseSensitive(root)` | `discover.test.ts` [H] |
| 17 | a **monorepo**: `packages/*/AGENTS.md`, `packages/*/.cursor/rules/*.mdc`, one root `AGENTS.md` **[new]** | root `AGENTS.md` → `<repo>/AGENTS.md`; each package file → a topic or rule with `paths: ["packages/<n>/**"]` derived from its directory, never flattened; the report groups them under `## Memory → …` with the package prefix; `walkDepth` 8 covers `packages/<n>/src/<a>/<b>` | destination assignment from the source's directory relative to the git root | `plan-monorepo.test.ts` [H] |
| 18 | a monorepo with 120 package rules **[new]** | `ruleFiles: 200` not exceeded; at 200 the report says `rule budget 200 reached; 14 rules not imported (most specific kept)`; `matchRules` stays memoised per step | `ruleFiles` cap in `plan.ts` | `plan.test.ts` + `rules.test.ts` [H] |

### B. Reading and parsing (13)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 19 | `.mdc` with no frontmatter, or a broken one | body imported, `trigger: manual`, `warnings: ['frontmatter unparsable: <reason>']`; never a throw | tolerant frontmatter (`---` on line 1 only) | `parse/mdc.test.ts` [H] |
| 20 | JSONC with `//`, `/* */` and trailing commas (`opencode.jsonc`, `~/.copilot/config.json` — real) | parsed; comments dropped with a note | string-aware scanner | `parse/jsonc.test.ts` [H] |
| 21 | TOML with `[profiles.x]`, `[mcp_servers.y]`, quoted table keys `[projects."/Users/x/y"]` (real, ×6 here) | dotted paths preserved verbatim, the quoted absolute path staying **one** segment | `parse/toml.ts` returns `{path[], value}` | `parse/toml.test.ts` against the real key set [H] |
| 22 | frontmatter booleans `yes/no/on/off/1/0` (Claude skills accept all six) | coerced; anything else kept as a string | `frontmatter.ts boolOf` | `parse/frontmatter.test.ts` [H] |
| 23 | flat `type:` (docs) **vs** nested `metadata.type:` (all 43 real files) | both accepted and mapped to `kind`; neither ⇒ `kind: reference` | `kindOf(fm)` checks both | `parse/frontmatter.test.ts` [H] |
| 24 | **binary file with a `.md` extension** (a PNG named `notes.md`, a UTF-16LE file with no BOM, a 4 KiB run of NULs) **[new]** | `skip:not-text`; detected by a NUL in the first 8 KiB or a failed UTF-8 decode; never fed to the markdown parser, never hashed as text | file rule 5 | `parse/markdown.test.ts` [H] |
| 25 | **encodings**: BOM (UTF-8, UTF-16LE, UTF-16BE), CRLF, lone CR, invalid UTF-8, mixed | BOM stripped; UTF-16 with a BOM decoded; CRLF and lone CR → LF; invalid UTF-8 → `skip:not-text`; the normalised text is what is hashed, so the same logical file from two tools dedupes | `Buffer` sniff in `markdown.ts` | `parse/markdown.test.ts` [H] |
| 26 | bidi controls, ANSI escapes, `U+2028`/`U+2029` in a body | stripped before write (the `BIDI_RE` of `session/index.ts:47` reused); `warnings: ['3 control characters removed']` | write-time sanitiser | `apply.test.ts` [H] |
| 27 | SQLite sources (`state_5.sqlite`, `thread_history_1.sqlite`, `memories_1.sqlite`, `opencode.db`, Cursor `state.vscdb`) | `skip:unsupported — sqlite (no reader)`; if a reader is ever added and its module is absent, the same skip, never a crash | guarded dynamic import | `parse/sqlite.test.ts` [H] |
| 28 | one malformed file among 43 | that row `skip:parse-error` with the code; the other 42 import; exit 0 | per-file try/catch + `notices` | `classify.test.ts` [H] |
| 29 | **a 4.1 MiB `CLAUDE.md`** | `skip:oversize (4,299,161 bytes; larger than 4 MiB)` — the existing `instructions.ts:143` wording | `stat().size` before read | `classify.test.ts` [H] |
| 30 | a 900 KiB `MEMORY.md` index | read (under cap) but clipped to `memoryIndexBytes` at write with `clipped: 917504` in frontmatter and a `## Notices` line | `memoryIndexBytes` | `plan.test.ts` [H] |
| 31 | a file whose size changes between `stat` and `read` | the read is capped at the stat'd size + 64 KiB slack; beyond that `skip:oversize (grew during read)` | capped read | `discover.test.ts` [H] |

### C. Imports, references and traversal (6)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 32 | `CoArena/CLAUDE.md` is exactly `@AGENTS.md` (**real, 11 bytes**) | resolved, inlined once, then deduped against the `AGENTS.md` row → one destination, `tools` unioned, `warnings: ['@AGENTS.md inlined']` | resolve → normalise → sha256 compare | `imports.test.ts` with the real one-liner [H] |
| 33 | `@~/.ssh/id_rsa`, `@../../.env`, `{file:~/.aws/credentials}`, `${file:/etc/shadow}` | refused; the body keeps `<!-- jevcode: unresolved @~/.ssh/id_rsa (outside <root>) -->`; `isSecretBasename` refuses independently | root check + `paths.ts:114,155` | `imports.test.ts` [H] |
| 34 | cycle `a.md → b.md → a.md` | stops; `warnings: ['import cycle at b.md']`; both bodies present once | visited set | `imports.test.ts` [H] |
| 35 | `@path` inside a fence or an inline code span | **not** expanded (Claude's own rule) | fence/span-aware scanner | `imports.test.ts` [H] |
| 36 | a depth-5 chain | stops at 4 hops: `warnings: ['import depth 4 reached at e.md']` | depth counter | `imports.test.ts` [H] |
| 37 | an `instructions[]` entry that is an `https://` URL (opencode) | **never fetched**; row `skip:remote` with `the importer does not fetch URLs; paste it with /memory add` | scheme check in `sources.ts` | `discover.test.ts` [H] |

### D. Classification and secrets (16)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 38 | `env.ANTHROPIC_API_KEY` in `~/.claude/settings.json` (**real**) | SECRET; TTY `1` → `addSecret` then `writeCredentials({apiKey})`; the item shows `sha256:3f2a…` only; `--yes` in a pipe refuses it | key rule 1 | `secrets.test.ts` + `import.test.ts` [H/T] |
| 39 | `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.claude/sessions/*.key`, `~/.local/share/opencode/auth.json`, `~/.gemini/mcp-oauth-tokens.json` | **named, not read** — existence and byte count only; never opened | `isSecretBasename` + the atlas class | `discover.test.ts` [H] |
| 40 | MCP `env: {GITHUB_TOKEN: "ghp_xxx…"}` | destination `"${GITHUB_TOKEN}"`; note *the source held a literal value; only the name was imported*; the value never printed | key rule 3 (`github` family) | `mcp.test.ts` [H] |
| 41 | MCP `headers: {Authorization: "Bearer sk-…"}` | header name kept, value → `${MCP_<SERVER>_AUTH}` with a note; credential-looking vars are never expanded into a remote url/headers | key rule 1 | `mcp.test.ts` [H] |
| 42 | **all nine env syntaxes** (`${VAR}`, `${VAR:-d}`, `${env:VAR}`, `{env:VAR}`, `$VAR`, `%VAR%`, `env_key`, `bearer_token_env_var`, `${input:id}`) plus `${workspaceFolder}`, `${userHome}`, `${pathSeparator}` | all normalised to `${VAR}`; `${input:id}` → `${ID_UPPER}` + note; `${workspaceFolder}` → `${JEVCODE_WORKSPACE}`; `${userHome}` → `${HOME}` | `mcp.ts normaliseRef` | `mcp.test.ts`, one case per syntax [H] |
| 43 | **a network MCP server**: `{type:"http", url:"https://mcp.example.com/v1", headers:{Authorization:"Bearer …"}, oauth:{clientId, clientSecret, scopes}}` **[new]** | imported **disabled**, transport `http`, url kept, `Authorization` → `${MCP_EXAMPLE_AUTH}`, `oauth.clientSecret` classed SECRET and dropped with a note, `oauth.clientId` kept, `scopes` kept; **nothing is dialled** — the importer makes no network request of any kind | `mcp.ts` + key rules 1, 7 | `mcp-network.test.ts` [H] |
| 44 | a remote MCP whose `url` contains `${ANTHROPIC_API_KEY}` | the reference is preserved in the file but flagged: `warnings: ['a credential-looking variable appears in a remote url; it will not be expanded']` — matching Claude Code's own behaviour | `mcp.ts` | `mcp-network.test.ts` [H] |
| 45 | `clientId: "a7f3…"`, 32 hex, name not allowlisted | in band → Jev group I; Jev unavailable → **secret** (conservative) | key rule 8 + band | `secrets.test.ts` [H] |
| 46 | Jev says not-secret, code rule 2 or 3 says secret | **secret** — Jev promotes into the class, never out of it | the decision joiner | `secrets.test.ts` [H] |
| 47 | a 64-hex `sha256:` field, a uuid, `machineID`, an etag | CONFIG, never in band | key rule 8 allowlist | `secrets.test.ts` [H] |
| 48 | **a secret inside a memory body** — `sk-ant-api03-…` pasted into someone's `CLAUDE.md` | written as `[REDACTED:pattern]`; row `warnings: ['1 value redacted']`; the value is absent from report, plan, index, destination and every Jev request | write-time redactor (exact set, then the 15 families) | `apply.test.ts` + the leak gate [H] |
| 49 | a memory body with a PEM private key spanning 30 lines | the whole span redacted (`pemSpans`, `redact.ts:286`); `warnings: ['1 value redacted']` | same | `apply.test.ts` [H] |
| 50 | a repo `.env` with 14 variables, 6 secret-like | never imported as memory; the report lists `14 variables, 6 secret-like` and the **names** under `## Credentials`; values never enter a row | `readDotenv` (`env.ts:27`) + `SECRET_NAME_RE` | `discover.test.ts` [H] |
| 51 | `permissions.allow` (12), `prefix_rule(decision="allow")` (8), `trust_level = trusted` (**×6, real**), `permission.bash: allow`, `trust: true`, `hasTrustDialogAccepted` | all `suggest`; **zero bytes written**; the section's closing line names `--sandbox` and `/trust` | key rule 5 | `classify.test.ts` + `import-authority.test.ts` [H] |
| 52 | `` !`date` ``, ```` ```!node -e … ````, `!{git log}`, `$(whoami)`, `` `uname` `` in a command body | each fenced as ```` ```text (not run) ````; `executable-stripped: 5`; nothing runs | `markdown.ts fenceExecutables` | `markdown.test.ts` + `import-no-exec.test.ts` [H] |
| 53 | `~/.claude/workflows/*.js`, `hooks` in any settings layer, plugin `hooks/hooks.json`, `notify = [...]`, `statusLine`, `apiKeyHelper` | `skip:unsupported` / `suggest` with the reason; `meta.name` and `meta.description` shown for `.js` so the human knows what they had | key rule 6, file rule 6 | `classify.test.ts` [H] |

### E. Plan, duplicates, conflicts, budget (11)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 54 | `~/.codex/skills/.system/{review-agent,skill-creator,plugin-creator,skill-installer,openai-docs,imagegen}/SKILL.md` (**real, bundled**) | `skip:third-party (bundled)`; only the human's own `~/.codex/skills/<n>/` imports | path predicate `/skills/.system/` | `classify.test.ts` [H] |
| 55 | Jaccard 0.78 pair | in band → Jev `same_meaning`; `p = 0.41` → **keep both**; report `duplicate not resolved — both imported` | `plan.ts` dedupe | `plan.test.ts` [H] |
| 56 | identical bodies after normalisation, different paths | one row, `tools` unioned, no Jev asked | normalised sha256 | `plan.test.ts` [H] |
| 57 | **conflicting rules**: "always explain before patching" (`~/.claude/CLAUDE.md`) vs "never write prose before a patch" (`~/.codex/AGENTS.md`) | the polarity precondition fires → Jev `contradicts` → both rows `review`, grouped, four options; nothing written until answered; `Enter` with nothing chosen = `1 keep both` | `plan.ts` conflicts | `plan.test.ts` + `import-reducer.test.ts` [H/T] |
| 58 | a rule that contradicts an **existing** `AGENTS.md` line (not another import) | same treatment; the existing line's location is shown as `AGENTS.md:41` | conflicts run against loaded instructions too | `plan.test.ts` [H] |
| 59 | **duplicate names** from different tools: `~/.claude/commands/test.md` and `~/.codex/prompts/test.md`, different bodies | the second becomes `commands/test-codex.md`; both keep provenance; the palette shows both with distinct descriptions; a *third* collision gets `-2` | slug allocator | `plan.test.ts` [H] |
| 60 | two sources both slugging to `project-jevcode` | second → `project-jevcode-2`; the index disambiguates by summary | slug allocator | `plan.test.ts` [H] |
| 61 | 43 notes against a 512 KiB / 200-line budget | 9 indexed (group IV, or the code order on abstention), **34 on demand, 0 dropped**; `43 notes → 9 indexed, 34 on demand (512 KiB budget)` | budget pass after dedupe | `plan.test.ts` [H] |
| 62 | a rule with `globs: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"]` expanding past 200 | expanded, then capped: `warnings: ['glob budget 200 reached; 38 patterns dropped']` | `rulePatterns` | `plan.test.ts` [H] |
| 63 | a Windsurf rule at its own 12 000-char limit against the 4 KiB cap | clipped with `warnings: ['clipped 12,000 → 4,096 bytes']`, a `<!-- jevcode: clipped -->` trailer and a `## Notices` line | `ruleBytes` | `plan.test.ts` [H] |
| 64 | 2 000 plan rows, near-duplicate heavy **[G1.6]** | minhash bucketing keeps comparisons under `dedupePairs: 20 000`; overflow ⇒ `notice: duplicate scan capped at 20,000 pairs (N candidates)`; the plan phase stays ≤ 400 ms p95 | `plan.ts` | `perf/import.ts` row 3 [H] |

### F. Apply, idempotency, trust, concurrency (17)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 65 | **re-run, nothing changed** | every row `skip:unchanged`; **0 bytes written**; `[import] nothing new since imp_… (41 unchanged)` | manifest source sha256 | `import-twice.test.ts` [H] |
| 66 | source `CLAUDE.md` edited since the import | `update`: the marker block's interior replaced, the new sha in the marker; bytes outside untouched | manifest + markers | `apply.test.ts` [H] |
| 67 | **the human deleted the marker block** from `AGENTS.md` (partially migrated) | `review — the block was edited or removed; nothing was written`; never re-appended | markers absent, manifest present | `apply.test.ts` [H] |
| 68 | **the destination file was deleted** since the import **[G1.3]** | `create`, with `notice: destination was removed since imp_…; re-creating` | the matrix cell the spine omitted | `import-twice.test.ts` [H] |
| 69 | **a second clone of the same repo at a different path** **[G1.3]** | full `create` rows — the manifest is keyed by `realpath(gitRoot ?? workspace)`, so clone B is not "already imported" | `workspaceKey` | `import-twice.test.ts` [H] |
| 70 | **partially migrated**: half the notes imported by an earlier JevCode version (manifest `v: 0`, no `workspaces` key) **[new]** | the manifest reader upgrades `v: 0` in memory (all entries → the current `workspaceKey`), never rewrites it until the next successful apply; already-imported rows are `skip:unchanged`; the rest `create`; `notice: manifest upgraded from v0` | `config/imports.ts` tolerant reader | `imports.test.ts` [T] |
| 71 | **a source changed between the report and `y`** **[G1.1]** | `review — source changed since the plan (9f8e7d6c → 1a2b3c4d); nothing was written`; the other rows apply; exit 2 | re-stat + re-hash before each write | `import-source-toctou.test.ts` [H] |
| 72 | **a destination slug that escapes** (`name: ../../.git/hooks/pre-commit`, a filename with `..`, a 400-char unicode name, a name that normalises to empty, a symlinked destination) **[G1.2]** | all confined by `slugOf` + `isInside` + the `lstat` refusal; `.git/hooks` untouched; the symlinked destination is `review` | `plan.ts slugOf`, `apply.ts` assertion | `import-slug-escape.test.ts` [H] |
| 73 | SIGKILL mid-apply | every destination is either its pre-image or its final bytes; `--resume` finishes from `apply.jsonl`; no row applied twice | `writeFileAtomic` + append-after-write | `import-resume.test.ts` (kills a child) [H] |
| 74 | two `jevcode import --yes` at once | one takes the lock; the other prints `an import is applying (pid 1234, 14 s ago) — try again when it finishes`, exit 2 | `O_EXCL` + pid liveness + 10-min ttl | `lock.test.ts` [H] |
| 75 | **`--undo` while an apply runs, or two `--undo`s** **[G1.4]** | the lock covers undo and resume too, so the second refuses with the same line | the widened lock | `lock.test.ts` [H] |
| 76 | a stale lock (dead pid, or 11 minutes old) | taken over: `notice: replaced a stale import lock (pid 1234 gone)` | `isPidAlive` + age | `lock.test.ts` [H] |
| 77 | **`--undo` after the `pre/` dir was deleted** **[G1.4]** | `review — pre-image unavailable (~/.jevcode/imports/<id>/pre removed); left alone`; not an exception; the other rows restore | per-row check | `undo.test.ts` [H] |
| 78 | `/import` while a run is live | dry run allowed; apply refused with `error: /import runs when the run is idle; Esc pauses first`; the draft is cleared | `availableDuringTask: 'idle'` | `dispatch.test.ts` [T] |
| 79 | **EACCES / ENOSPC** on `.jevcode/memory/MEMORY.md` | that row fails, the other 40 apply, `[import] error: could not write … : EACCES (40 of 41 applied)`, exit 2 | per-row try/catch, `ConfigError` wording | `apply.test.ts` [T] |
| 80 | `AGENTS.md` appended, stored decision `trust` **[G1.5]** | re-pinned only when the new bytes reconstruct from old + the blocks written (append) **or** old with each block's interior replaced (update); otherwise the pin is left and the next start re-prompts once | `repinAfterApply` reconstruction | `trust.test.ts` + `session.test.ts` [T] |
| 81 | workspace trust decision `none` | project rows `skip:untrusted` with `run /trust, then /import again`; user rows still apply; the report says which | `evaluateTrust` before destination assignment | `import.test.ts` [T] |

### G. Surfaces, twins and platform (11)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 82 | **`--undo` after the human edited one destination** | 40 restored byte-identical (modes too); the edited one `review — modified since the import; left alone`; manifest entries removed only for the restored rows | `sha256After` comparison | `undo.test.ts` [H] |
| 83 | **no git root** (a bare directory) or a read-only repo | project scope unavailable → user scope only, with `project scope unavailable (no git root)` / `(read-only)`; `--scope=project` then exits 2 with that reason; **user-scope import still works entirely** | `gitRoot === null` / `access(W_OK)` | `plan.test.ts` [H] |
| 84 | **a non-git dir that is a subdir of a git repo** | `instructionSearchDirs` semantics are reused: the workspace and the git root define the range, never above it | `instructions.ts:76` reused | `plan.test.ts` [H] |
| 85 | **Windows paths** **[new]** | `%USERPROFILE%` and `%APPDATA%` roots; backslash separators normalised to `/` in every *displayed* path and in every `paths:` glob, while the real path keeps the platform separator; a drive-relative path (`C:foo`) is rejected as not absolute; UNC (`\\server\share`) is accepted as a root but never as a destination; `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` and names ending in `.` or a space are refused by `slugOf`; `0600` is replaced by the `WINDOWS_ACL_NOTE` (`credentials.ts:29`) in every item; CRLF is normalised on read and **written back as LF** | `rootFor` platform rows, `slugOf`, `displayPath` | `windows-paths.test.ts` (platform-stubbed) [H] |
| 86 | `--json` | one `ImportPlan` object on stdout, no prose, no ANSI, no secrets | the `JSON_CMDS` path | `import.test.ts` + the leak gate [T] |
| 87 | `--plain` | numbered report, `Enter selection (1-N):`, conflicts and credentials as text prompts, same strings | the `createPlainPrompter` twin | `plain-prompter.test.ts` + pty `r4-import-plain` [T] |
| 88 | `--screen-reader` | numbered lists, no bullets, counts as words; no key is ever spoken (there is none in the state) | the `WizardView.screenReader` idiom | `lines.test.ts` + pty `r4-import-sr` [T] |
| 89 | `--ascii` | `->`, `-`, `...`, `>=` in every import string | the `glyphs.ts:223` twin map | `lines.test.ts` + pty `r4-import-ascii` [T] |
| 90 | pipe / `--no-input` | dry run only; report path + one summary line; exit 0; nothing applied; `--yes` applies non-credential rows | `!isTTY` | pty `r4-import-pipe` (`expectedExit 0`) [T] |
| 91 | `--mock` | Jev never asked; `jev: not asked (mock)`; all fallbacks; the plan is complete | `--mock` short-circuits `questions.ts` | `import.test.ts` [T] |
| 92 | resize during the overlay, 24×80 → 12×60 → 40×120 | rows clamp to `overlayWant`; zero clears outside the shrink; the selected row stays visible; the overlay collapses under a live run | `layout.ts` `COLLAPSING` + `overlayWant` | pty `r4-import-overlay` [T] |

### H. Live-session races and the wizard (5)

| # | Case | Expected | Detected at | Test |
| --- | --- | --- | --- | --- |
| 93 | `Ctrl-C` during discover / during apply / in the overlay | discover: aborts, nothing written, `[import] cancelled · nothing was written`; apply: finishes the current file, `applied 9 of 41 — jevcode import --resume imp_…`, exit 130; overlay: closes (command-opened, never exits) | `AbortSignal` chained; `cancelCloses` | `import.test.ts` + pty `r4-import-ctrlc` [T] |
| 94 | **`/memory reload`, or an edited rule file, while a run is live** **[G2.8]** | rules and topics are re-read per step, so a reload would otherwise mutate the prompt mid-run with no step boundary and no item. **Rule: the matched rule/topic set is pinned at run start.** A reload during a live run emits `[memory] reloaded — active from the next run (this run keeps the 6 rules it started with)` and changes nothing in flight; between runs it takes effect immediately | the rule set is snapshotted into `EngineOptions.memory` at `createEngine` | `session.test.ts` + `engine.test.ts` [T/H] |
| 95 | a memory file edited by the agent's own `write` during a run | impossible for project memory: `<ws>/.jevcode/{memory,rules,commands}` are write-denied in the sandbox (§2.11); outside a sandbox the pinned set still governs the run, and the next run picks the change up | `seatbelt.ts` write denies + the pin | `seatbelt.test.ts` + `engine.test.ts` [H] |
| 96 | the wizard's import probe on a machine with nothing installed | the step is **not shown** (no offer for nothing); the flow stays `sandbox → done` | `reducer.test.ts` [T] |
| 97 | `3 never`, then restart | `seen.import: "never"` in the config file; the step never shows again; `/import` still works; `jevcode config --all` shows the row | `session.test.ts` [T] |

### The task's named cases, and where each lands

| Named case | Rows |
| --- | --- |
| huge files | 14, 29, 30, 31 |
| binary | 24, 25, 27 |
| symlinks | 10, 11, 33, 72 |
| secrets in memory | 48, 49, 50 |
| duplicate names | 8, 56, 59, 60 |
| conflicting rules | 57, 58 |
| different encodings | 25, 26, 85 |
| missing index | 61 (index synthesised from topic files), 67 (block removed), 70 (partial manifest) |
| partially migrated | 67, 68, 70 |
| re-run | 65, 66, 68, 69 |
| permission denied | 12, 79, 81 |
| network MCP configs | 37, 43, 44 |
| per-project vs user level | 17, 69, 81, 83 |
| monorepos | 17, 18 |
| non-git dirs | 83, 84 |
| Windows paths | 85 |

---

## §7 Owner split

Every file has exactly one owner. **[H]** = harness slot, **[T]** = TUI session slot. Shared-file changes are
written verbatim so the owner lands them without a second design pass (the TD3 §7.2 convention).

| Slot | Owns | New / changed files |
| --- | --- | --- |
| **Harness** | the pure engine and the report format | `src/import/{sources,discover,classify,secrets,questions,plan,report,apply,mcp,rules}.ts` + `src/import/parse/{frontmatter,markdown,mdc,jsonc,toml,jsonl,sqlite}.ts` (all new), `src/core/types.ts` (additive), `src/core/limits.ts` (shared, §7.1), `src/provider/prompts.ts`, `src/loop/context.ts`, `src/sandbox/seatbelt.ts` |
| **TUI session** | every surface and every write | `src/cli/import.ts` (new), `src/cli/{args,main.tsx,session,tui-prompter}.ts`, `src/config/imports.ts` (new), `src/config/{defaults,types,validate,instructions,trust}.ts`, `src/tui/import/{reducer,lines,Report.tsx}` (new), `src/tui/commands/project.ts` (new), `src/tui/{layout,Overlay.tsx}`, `src/tui/commands/{registry,dispatch,palette}.ts`, `src/tui/onboarding/{reducer,lines,Wizard.tsx}`, `src/tui/plain-composer.ts`, `src/session/index.ts`, `src/chat/{facts,llm-turn}.ts` |

### 7.1 W0 — contract and bounds, and the cross-design ordering **[G2.2]**

`src/core/limits.ts`, the `src/core/types.ts` contract line and the `src/provider/prompts.ts` fill order are
**co-owned with the coordination plan**: `CD` row 3 (`COORDINATION-DESIGN.md:1908`) creates `limits.ts`, and
`CD` row 19 (`:1944`) reworks the prompt sections for ~210 LOC. The spine hedged only on `src/loop/context.ts`
and never stated the ordering, so whichever design landed second would rebase.

**The rule:** import W0 lands **after** coordination W0.

- `IMPORT_LIMITS` is an **additive export** in the file coordination creates, never a second file.
- The import additions to `src/core/types.ts` go **after** coordination's round-3 contract line, as
  `// contract 1.6`.
- `## Memory (index)`, `## Rules in scope` and `## Memory in scope` are filed as an **amendment to `CD` row
  19**, not as an independent edit to `prompts.ts`.
- `CheckpointState.kept?[].kind += 'memory'` is an amendment to `CD` `:1174`, which introduces `kept`.

If coordination slips, import W0 ships `src/core/limits.ts` with **only** `IMPORT_LIMITS` and a header comment
naming the incoming rows, so the merge is an append.

| # | File | Change | LOC |
| --- | --- | --- | --- |
| 1 | `src/core/types.ts` [H] | `// contract 1.6`: `SourceTool`, `SourceItem`, `SourceScope`, `SourceFormat`, `ImportClass`, `ImportAction`, `PlanRow`, `ImportPlan`, `ImportProbe`, `ImportManifest`, `MemoryItem`, `MemoryKind`, `RuleTrigger`, `ProjectCommand`, `McpServerRecord`. Widen: `InstructionRecord += kind?, scope?`; `EngineOptions.memory?: {index?, rules?, topics?}`; `NoticeKind += 'import'`; `RunMeta.imports?: readonly string[]`; (amendment) `CheckpointState.kept?[].kind += 'memory'` | ~190 |
| 2 | `src/core/limits.ts` [H] | `IMPORT_LIMITS` (Appendix B), plus the re-export of the three `PROMPT_LIMITS` values §2.10.3 touches | ~70 |
| 3 | `test/unit/core/limits.test.ts` [H] | every bound positive and finite; `agentsAppendBytes + 24 KiB ≤ INSTRUCTIONS_MAX_BYTES`; the two shares in `(0, 0.5)` | ~35 |

### 7.2 W1 — sources, discover, parsers ∥ CLI skeleton, settings, manifest

| # | File | Change | LOC | Tests |
| --- | --- | --- | --- | --- |
| 4 | `src/import/sources.ts` [H] | the atlas: ~70 `SourceSpec` rows for 9 tools + Claude Desktop + 8 MCP dialects; `rootFor()` | ~520 | `sources.test.ts` ~90 |
| 5 | `src/import/discover.ts` [H] | bounded walk, exclusions, `.gitignore`, symlink policy, inode cycles, **per-volume case probe [G1.6]**, realpath dedupe, `skip:self`, transcript metadata pass; injected `fs` seams | ~320 | `discover.test.ts`, `discover-dedupe.test.ts`, `slug.test.ts` ~260 |
| 6 | `src/import/parse/frontmatter.ts` [H] | tolerant YAML subset, one nesting level, six boolean spellings, `kindOf` accepting flat **and** nested `type` | ~140 | `parse/frontmatter.test.ts` ~80 |
| 7 | `src/import/parse/markdown.ts` [H] | encoding normalisation, NUL/binary sniff, headings, fence map, `fenceExecutables`, `@import` resolution, HTML-comment strip, token set + Jaccard, **minhash bucketing [G1.6]** | ~260 | `parse/markdown.test.ts`, `imports.test.ts` ~170 |
| 8 | `src/import/parse/{mdc,jsonc,toml,jsonl,sqlite}.ts` [H] | five parsers, none throwing | ~300 | one test each ~150 |
| 10 | `src/cli/args.ts` [T] | `Command += 'import'`; 7 string flags, 6 boolean flags, `FLAGS` rows scoped `commands: ['import']`; `ParsedFlags` additions; positional validation against the atlas; `PATHS` / `JSON_CMDS`; usage text | ~140 | `import-args.test.ts` ~120 |
| 11 | `src/cli/main.tsx` [T] | `case 'import':` in the switch (`:425-486`) | ~10 | `main.test.ts` +10 |
| 12 | `src/cli/import.ts` [T] | the handler over `CommandIo`: roots → discover → classify → plan → report → (TTY ? overlay : print) → apply through the write seams → manifest → trust re-pin; lock, resume, undo; exit codes | ~440 | `import.test.ts` ~220 |
| 13 | `src/config/imports.ts` [T] | manifest read (tolerant, **v0 upgrade**, **keyed by workspace [G1.3]**) / merge / atomic 0600 write; `importDestinations()`; `importArtifactDir()`; **retention GC [G1.4]**; the 17 `[import]` item builders | ~240 | `imports.test.ts` ~140 |
| 14 | `src/config/{defaults,types,validate}.ts` [T] | 6 `SETTINGS` rows + 6 `SettingName` members; two enum checks; the USD validator reused | ~70 | `defaults.test.ts` +40 |

### 7.3 W2 — classify, questions, plan, report ∥ the overlay and the command surface

| # | File | Change | LOC | Tests |
| --- | --- | --- | --- | --- |
| 16 | `src/import/classify.ts` [H] | the 12 file rules + 9 key rules with `p` and bands; the non-secret allowlist; the dotted-path walk | ~380 | `classify.test.ts` ~150 |
| 17 | `src/import/secrets.ts` [H] | `shapeOf(value)` with **no substring retained**; `classifyValue`; the band predicate; the promote-only joiner | ~200 | `secrets.test.ts` ~130 |
| 18 | `src/import/questions.ts` [H] | the five groups, batching, `assertQuestionBatch`, the `--jev-sample` gate (**group V narrowed [G2.4]**), the `jevMaxUsd` cutoff, `resolveAnswers` with the intake floors | ~260 | `questions.test.ts` ~140 |
| 19 | `src/import/plan.ts` [H] | dedupe (sha → minhash bucket → Jaccard → Jev), conflicts, destinations, **`slugOf` [G1.2]**, glob expansion + caps, the budget pass, the re-run matrix incl. **the absent-destination cell [G1.3]** | ~380 | `plan.test.ts`, `plan-scope.test.ts`, `plan-monorepo.test.ts` ~300 |
| 20 | `src/import/report.ts` [H] | `renderReport(plan, view)` + `plan.json`; cell-measured; `--ascii` aware; a debug assertion that no rendered row matches any `REDACTING_PATTERNS` entry | ~250 | `report.test.ts` ~110 |
| 22 | `src/tui/import/reducer.ts` [T] | the pure `ImportUiState` machine, **groups-first with `y` as the common path [G2.5]**; no body text and no secret byte in the state | ~300 | `import-reducer.test.ts` ~170 |
| 23 | `src/tui/import/lines.ts` [T] | every import string: overlay rows, hints, report heads, action words, the `[import]` re-exports, `--ascii` / SR twins; cell-measured | ~300 | `import-lines.test.ts` ~150 |
| 24 | `src/tui/import/Report.tsx` [T] | the Ink renderer over `importLines`; reuses `Review.tsx`'s span renderer for `d` | ~190 | `import-report.test.tsx` ~80 |
| 25 | `src/tui/{layout,Overlay.tsx}` [T] | `OverlayKind += 'import'` (`:52,55`), `COLLAPSING` (`:58`), `overlayWant` (`:87`), `OverlayData.import?` (`Overlay.tsx:66`) | ~40 | `layout.test.ts` +40 |
| 26 | `src/tui/commands/{registry,dispatch,palette}.ts`, `project.ts` [T] | the two `CommandSpec` rows; the project-command layer consulted after `findCommand` (`registry.ts:576`); the `[project]` palette tag; `/memory` sub-verb parsing | ~230 | `registry.test.ts`, `dispatch.test.ts`, `project.test.ts` ~160 |
| 27 | `src/cli/tui-prompter.ts` [T] | `openImport(open)` on `TuiRenderer`; the prompter's `import(plan)`; cancel wired into the pending set (`:161-162`) | ~120 | `tui-prompter.test.ts` +70 |

### 7.4 W3 — apply, undo, MCP, seatbelt ∥ wizard, `/memory`, loader, trust, index, facts

| # | File | Change | LOC | Tests |
| --- | --- | --- | --- | --- |
| 29 | `src/import/apply.ts` [H] | the ordered pipeline over injected seams; `pre/` snapshots; markers; `apply.jsonl`; **source re-verification [G1.1]**; **destination confinement [G1.2]**; resume; undo incl. **the missing-pre-image row [G1.4]**; the lock **widened to undo and resume [G1.4]** | ~330 | `apply.test.ts`, `import-source-toctou.test.ts`, `import-slug-escape.test.ts`, `import-resume.test.ts`, `undo.test.ts`, `lock.test.ts` ~420 |
| 30 | `src/import/mcp.ts` [H] | the eight-dialect normaliser; transport inference; env-reference normalisation; the never-expand rule; merge with collision suffixes | ~190 | `mcp.test.ts`, `mcp-network.test.ts` ~150 |
| 31 | `src/import/rules.ts` [H] | `matchRules(rules, paths)`, memoised, `ruleFiles`-capped | ~120 | `rules.test.ts` ~70 |
| 32 | `src/sandbox/seatbelt.ts` [H] | three write denies beside the `.git` ones (`:110`/`:134`); **the `memory-local` read deny emitted after `:181` [G2.1]** | ~30 | `seatbelt.test.ts` +50 (ordinal assertions) |
| 34 | `src/config/instructions.ts` [T] | additive `loadMemory(...)`: indexes, rule files (frontmatter + `paths:`), topic **headers** only with `readTopic(slug)` on demand; same caps, redaction and symlink policy; `InstructionRecord.kind`/`scope`. `loadInstructions` untouched | ~210 | `instructions.test.ts` +130 |
| 35 | `src/config/trust.ts` [T] | `probeTrustInputs` gains `memory: {index, topics, rules} \| null` (counts and sizes only) and counts it in `hasUntrustedInputs`; **`repinAfterApply` covering append *and* update [G1.5]** | ~100 | `trust.test.ts` +90 |
| 36 | `src/tui/onboarding/{reducer,lines,Wizard.tsx}` [T] | `WizardStep += 'import'` (`reducer.ts:26`); `importProbe` / `importChoice` state; two actions; the 3 rows + narrow + SR twins; `WizardHost.importProbe?` / `openImport?`; `seen.import` via `writeConfigValue` | ~230 | `onboarding.test.ts` +120 |
| 37 | `src/cli/session.ts` [T] | `/import` and `/memory` dispatch; the wizard host; the 50 ms probe **after the first frame**; the items; the trust re-pin call; the `import` index line; `applyConfig` for the 6 settings; the `--plain` twin; **the run-start rule pin [G2.8]** | ~360 | `session.test.ts` +200 |
| 38 | `src/session/index.ts` [T] | `INDEX_KINDS += 'import'` (`:36`); body parser; `SessionRow.imports?` | ~50 | `index.test.ts` +40 |
| 39 | `src/chat/{facts,llm-turn}.ts` [T] | the 15th `FactKey` `memory` with topic, 4 true and 4 false examples and the live-count text; `## Memory (index)` after `## Instructions (AGENTS.md)` (`llm-turn.ts:93`), same trust gate | ~90 | `facts.test.ts`, `llm-turn.test.ts` +80 |

### 7.5 W4 — prompt sections ∥ twins, pty, generated docs

| # | Owner | File | Change | LOC |
| --- | --- | --- | --- | --- |
| 41 | [H] | `src/provider/prompts.ts` | `## Memory (index)` in the once-per-run system prompt after `## Project instructions`; `## Rules in scope` and `## Memory in scope` as **per-step** user-message sections; every bound from `limits.ts`; filed as an amendment to `CD` row 19 **[G2.2]** | ~130 |
| 42 | [H] | `src/loop/context.ts` | the fill-order slot after `kept`; the **share-based** budgets **[G2.7]**; clip notices; `EngineStatus.context?` counts the two sections | ~110 |
| 43 | [T] | `src/tui/plain-composer.ts`, `src/cli/session.ts` | the `--plain` / SR / `--ascii` / `--no-input` twins of the overlay, the conflict prompt and the credential prompt, all from `lines.ts` | ~150 |
| 44 | [T] | `test/pty/smoke/r4-import-*.steps` (9) + `test/pty/round4.pty.test.ts` | `offer`, `overlay`, `resize`, `plain`, `sr`, `ascii`, `pipe`, `empty`, `ctrlc` | ~260 |
| 45 | [T] | generated | `docs/COMMANDS.md`, `man/jevcode.1`, `completions/jevcode.{bash,zsh,fish}` regenerated with `import` and `memory`; the existing drift gate enforces the commit | 0 |

### 7.6 W5 — gates, perf, docs

| # | Owner | Item |
| --- | --- | --- |
| 46 | [H] | `perf/import.ts` + a `src/perf/main.ts` row: discover p95, **plan-phase p95 [G1.6]**, probe p95; first-frame gate unaffected |
| 47 | [H] | `test/unit/import/leak.test.ts` — the §1 property 4 gate across seven artefacts and every captured Jev request body |
| 48 | [H] | `test/unit/import/no-exec.test.ts`, `test/unit/import/authority.test.ts` |
| 49 | [T] | `docs/IMPORT.md` (user-facing), `docs/STATUS.md` row, `CHANGELOG.md` |
| 50 | [T] | `docs/DECISIONS.md` — the six entries of Appendix C |
| 51 | both | one live paid run on the author's real machine: `--dry-run`, then `--yes --scope=user`, then `--undo`; the Jev cost and wall time recorded in `docs/STATUS.md` |

### 7.7 Totals and dependency order

| Slot | src LOC | test LOC |
| --- | --- | --- |
| Harness | ~3 460 | ~1 940 |
| TUI session | ~2 700 | ~1 700 |
| **Total** | **~6 160** | **~3 640** |

W0 lands alone, after coordination W0 **[G2.2]**. W1 [H] and W1 [T] are independent — the CLI calls stubs
returning empty plans. W2 [T] builds the whole overlay against a hand-written `plan.json` fixture before W2
[H] exists. **W3 is the first wave where both slots must meet**; the seam is `ImportPlan` in, `apply.jsonl`
out, pinned by a committed fixture at `test/fixtures/import/plan.json` at the end of W2. W4 [H] is the only
change that touches generator behaviour, and it is gated by the existing prompt snapshot tests.

---

## §8 Measurement

### 8.1 Fixture corpora

Four corpora under `test/fixtures/import/`. Every one is a *synthetic* tree: real **shapes**, fixture values.
No file copied from the author's machine, and every secret is a fixture constant that also appears in the
leak gate's needle list.

| Corpus | Shape | Size | Exercises |
| --- | --- | --- | --- |
| `empty/` | a `$HOME` with none of the nine tools | 0 artefacts | §6 rows 5, 96 |
| `single/` | Claude Code only: `~/.claude/{CLAUDE.md,rules/,skills/,commands/,settings.json}`, 3 project slugs with `memory/`, 2 transcripts | 34 artefacts | the happy path, the re-run matrix, undo |
| `all-nine/` | every tool present, deliberately overlapping: one `AGENTS.md` realpath reachable by 5 detectors, the same rule text in Cursor `.mdc` and Windsurf `.devin/rules/`, MCP servers in all 8 dialects, a conflicting instruction pair | **190 artefacts** | §1 properties 2, 11, 12; §6 groups C, D, E |
| `hostile/` | every §6 row that is an attack or a malformation: 4 executable forms, `name: ../../.git/hooks/pre-commit`, a symlinked destination, `@~/.ssh/id_rsa`, a cycle, a 4.1 MiB file, a PNG named `notes.md`, UTF-16 without a BOM, a NUL run, 6 credential families in bodies, a 12 000-char rule, a 900 KiB index, a remote MCP with `oauth.clientSecret`, Windows reserved names | 61 artefacts | §1 properties 3, 4, 8, 16; §A |

Two more are generated at test time rather than committed:

| Generator | Shape | Purpose |
| --- | --- | --- |
| `scale(n)` | `n` memory files with controlled Jaccard overlap, `n/10` rule files, `n/20` commands | the plan-phase perf gate **[G1.6]**, `n ∈ {100, 500, 2 000}` |
| `realshape()` | 12 project slugs, 43 topic files + 4 indexes, 3 fake worktrees, 3 371 zero-byte `.jsonl` placeholders, one 151 MB sparse file | the discover perf gate, without committing 2.7 GB |

### 8.2 Round-trip tests

A round trip is the property that makes provenance real: **what the importer wrote can be read back as what
it claims to be.**

| # | Round trip | Assertion |
| --- | --- | --- |
| R1 | source → plan → apply → **re-discover** | the destinations are `skip:self` on the second discovery; they never re-import themselves (§6 row 9) |
| R2 | source → apply → **`loadMemory`** | every written topic parses, `kind` is in the union, `paths` globs compile, `source.sha256` matches the source, and the index line count equals the indexed-topic count |
| R3 | apply → **undo** → sha compare | every destination byte-identical to `pre/`, modes restored, manifest entries removed (§1 property 9) |
| R4 | apply → **re-apply** | 0 bytes, every row `skip:unchanged` (§1 property 6) |
| R5 | plan → `report.md` → **parse the report** | a strict parser recovers the same row ids, actions and destinations from the rendered markdown as `plan.json` holds — the report is not allowed to say something the plan does not |
| R6 | MCP: source dialect → normalised record → **render back to the source dialect** | for the six dialects with a lossless subset, the round trip is byte-stable modulo key order; for Gemini `httpUrl` and Codex `env_key` the loss is asserted **explicitly** as a fixed note, so a silent loss becomes a test failure |
| R7 | `--json` plan → `--plain` render → **numbered selection** → apply | the row ids selected in the plain twin are exactly the ids applied |
| R8 | frontmatter → **write → re-read** | the six boolean spellings, the flat/nested `type`, quoted TOML keys and `paths:` lists all survive one hop unchanged |
| R9 | secret classification → **fingerprint stability** | the same value yields the same `sha256:<8>` across runs and platforms, and no other 8 hex chars of it ever appear |
| R10 | wizard probe → overlay → apply → **session index** | the `import` index line's counts equal the applied row counts, and folding the index reproduces `SessionRow.imports` |

### 8.3 Gate list

| Gate | Asserts | §1 property |
| --- | --- | --- |
| `import-dryrun-writes-only-artifacts` | the created-path set during a dry run | 1 |
| `plan-total` | rows by action sum to discovered; every action value covered | 2 |
| `import-no-exec` | `/tmp/pwned` absent; fences present; `enabled: false` | 3 |
| `import-leak` | 7 artefacts + every Jev body, 15 families + fixture needles → 0 hits | 4 |
| `import-jev-parity` | band-only divergence; 6 failure modes each complete | 5 |
| `import-twice` | 0 bytes; + the clone and deleted-destination rows **[G1.3]** | 6 |
| `import-source-toctou` **[G1.1]** | mutated source ⇒ row demoted, 0 bytes, exit 2 | 7 |
| `import-slug-escape` **[G1.2]** | 4 hostile names + a symlinked destination confined | 8 |
| `import-undo` | byte-identical restore; modes; the missing-pre-image row **[G1.4]** | 9 |
| `import-resume` | SIGKILL then resume; no double-apply | 10 |
| `plan-scope` | 4 scoped-rule sources land path-scoped | 11 |
| `discover-dedupe` | 5 detectors, 1 row | 12 |
| `lines` + 5 pty twins | identical strings across twins | 13 |
| `perf/import.ts` | discover / plan / probe p95 | 14, 15 |
| `import-authority` | 0 bytes of permission and hook classes; `enabled: false`; the seatbelt diff is exactly the three write denies plus the ordinal-correct read deny **[G2.1]** | 16 |
| `seatbelt` ordinal | the `memory-local` deny's line index > both allow lines' | 16 |
| `gen-docs` drift | the four generated files regenerate identically | — |

### 8.4 What the pty suite covers

`r4-import-offer` (the wizard rows at 24×80, 12×60, 40×120 — ≤ 3 rows in all three) · `r4-import-overlay`
(open → toggle → `y` → items; resize mid-overlay) · `r4-import-plain` · `r4-import-sr` · `r4-import-ascii` ·
`r4-import-pipe` (exit 0, nothing applied) · `r4-import-empty` · `r4-import-ctrlc` (three cancel points) ·
`r4-import-live` (`/import` during a run: dry run renders, apply refuses with the reused string).

### 8.5 Perf budgets, against measured numbers

Measured on the author's machine, 2026-09-21, warm cache, `find`-equivalent traversal:

| Operation | Measured today | Budget | Headroom |
| --- | --- | --- | --- |
| stat-probe of 9 home roots | ~1 ms | 10 ms | 10× |
| `~/.claude/projects/*/memory/*.md` glob (47 files) | ~15 ms | 50 ms (the wizard probe) | 3.3× |
| full walk of `~/.claude/projects` (10 220 entries, 9 911 files) | ~15 ms | 500 ms | 33× |
| full walk of one worktree (1 992 entries) | ~14 ms | — (excluded) | — |
| **25 worktrees if not excluded** | ~350 ms **and** ~50 000 entries (2.5× `walkEntries`) | — | the exclusion is why the cap is never hit |
| discover, all roots | not yet measurable | **1 500 ms p95** | — |
| plan phase at `scale(2000)` **[G1.6]** | — | **400 ms p95** | — |

Cold-cache numbers are not predictable across machines, which is exactly why the **caps**, not the
measurements, are the contract: `walkMs: 2 000` per root bounds a cold NFS `$HOME` to a notice rather than a
hang. The perf harness records all three rows so a regression is visible in `src/perf/main.ts` output.

### 8.6 The live validation run

One paid run, recorded in `docs/STATUS.md`:

1. `jevcode import` (dry run) on `/Users/…/JevCode` — expect ~47 memory candidates, 3 MCP servers from
   `~/.codex/config.toml`, 6 `trust_level` suggestions, 4 credentials found / 0 copied, 3 371 transcripts
   skipped, and `AGENTS.md` as a **`create`** (JevCode has none today).
2. `jevcode import --yes --scope=user` — apply user-scope rows only.
3. `jevcode chat` — confirm `## Memory (index)` is present and that the `memory` fact answers *"what do you
   remember about this repo?"* with no run.
4. `jevcode import --undo <id>` — confirm the byte-identical restore.
5. Record: Jev requests, questions, USD, wall time, rows by action, and the diff of `~/.config/jevcode/`
   before and after (expected: empty after the undo).

---

## §9 Open questions

These are the decisions the owner should make before W1; every one has a default in this document so the
build is not blocked on an answer.

**Ratified 2026-09-22** (harness owner; the TUI session concurred): **Q4** `--jev-sample` defaults to `headings`. Every
other question ships with its stated default; the contract line is `// contract 1.6`, after orchestration's 1.5.

1. **`memory-local` and `.gitignore`.** Should apply *offer* to append `.jevcode/memory-local/` to
   `.gitignore` (one line, shown as a diff), or only report it? **Default here:** offer, off by default in the
   overlay. Arguments against: touching `.gitignore` is a repo-visible side effect of a command whose whole
   pitch is "nothing is written until you approve it" — though the offer is itself an approval.
2. **Transcript-derived memory.** Metadata-only session history is in (§4.2.6). Should a later round let Jev
   *summarise* a transcript into a memory note — a paid, opt-in, per-session operation? **Default here:**
   defer. It is the one place where bodies would have to be read, and 2.7 GB of transcripts on one machine
   makes the cost and the privacy question both real.
3. **Keybindings import.** Claude's `keybindings.json` action names only partially map to JevCode's
   `KEY_ACTIONS`. Import the mappable subset with a report of the rest, or skip the file? **Default here:**
   import the subset, **off** by default in the overlay, with the unmapped actions listed.
4. **`--jev-sample` default.** `headings` (chosen) sends redacted heading text to Jev. `none` is strictly safer
   and measurably worse at file rules 11–12. **Owner call**; the flag and the setting exist either way, and
   **[G2.4]** already narrowed the one group that sent prose.
5. **opencode's SQLite store.** The schema is undocumented and one release recreated the directory and dropped
   legacy sessions (GitHub issue #34445). **Default here:** `skip:unsupported` with a report line. Worth a
   probe round only if opencode adoption matters.
6. **Cursor / Windsurf account-side memory.** Both are unreachable from disk (§3.11). Is a browser-assisted
   export worth building, or is `/memory add` enough? **Default here:** paste route only — the importer makes
   **no network request of any kind**, and that is a property worth keeping absolute.
7. **Should `trigger: always` rules be promoted into `AGENTS.md`?** §2.5 says no (a rule file with
   `paths: ["**"]`), which keeps uninstall symmetric but costs one per-step section instead of a system-prompt
   line. The alternative is cheaper per step and harder to undo. **Default here:** keep them as rule files.
8. **Retention default `importsKeep: 10` [G1.4].** Ten `pre/` snapshots of a large `AGENTS.md` is small; ten
   of a 900 KiB index set is not. Should retention be byte-based (`importsKeepBytes`) instead of count-based?
   **Default here:** count-based, with the GC notice naming the bytes reclaimed so the owner can see whether
   it matters.
9. **Does `/memory forget` need a project/user disambiguator?** A slug can exist in both scopes.
   **Default here:** `/memory forget <slug>` forgets the project one and says so; `--user` targets the other.

### 9.1 Where the spine's own citations were wrong

Every `file:line` in this document was re-read at `5a167b2`. Eight of the spine's citations did not survive,
and two of judgement 2's corrections were themselves wrong. Recorded here so the next reader does not
re-derive them.

| Spine / judgement said | The tree says | Consequence |
| --- | --- | --- |
| "all 16 `REDACTING_FAMILIES` + `WARN_ONLY_FAMILIES`" | **15**: 6 at `redact.ts:224-234`, 9 at `:278-296` | the leak-gate assertion's count **[G2.3]** |
| `registry.ts:44` for `CommandCategory` | `:45` | none |
| `reducer.ts:41` for `WIZARD_OPTIONS_ORDER` | `:42` | none |
| `credentials.ts:63-66` for `xdgConfigHome` | `:60` | none |
| judgement 2: "`seed.ts:28` → `:26`" | `pinnedFiles` **is** at `seed.ts:28`; the correction was wrong | none |
| `defaults.ts:126` for `noNetwork` | `:136` | none (cited from `CD`) |
| "the memory-local read deny, per the existing `addRead` pattern" | `addRead` feeds `:163`, overridden by `:181` | **[G2.1]**, a real hole |
| "`CheckpointState.kept`" as an existing field | not in `core/types.ts` at `5a167b2`; it is `CD` `:1174` | **[G2.2]**, an ordering dependency |
| "`~/.claude/projects` … three 23 MB transcripts" | **3 371** transcripts, 2.7 GB, largest **151 MB** | the perf budget and the transcript default (§8.5) |
| "24 full worktrees" | **25**, ~50 000 entries if walked | the exclusion is load-bearing (§6 row 6) |

---

## Appendix A — Security, in one place

### A.1 The threat model

| Adversary | Capability | Mitigation |
| --- | --- | --- |
| **A hostile repository** the human cloned | ships `.cursor/rules/*.mdc`, `.claude/commands/*.md`, `.mcp.json`, a `CLAUDE.md` with `@` imports, and frontmatter `name:` values | trust gate (§4.7.1); every project row visible with its source path before any write; nothing executes (§2.6); permissions never copied (§4.8.4); `--from` required for any root that is not the workspace or a tool home; **destination confinement [G1.2]**; MCP `enabled: false` |
| **A hostile file on disk** | a symlink into `~/.ssh`, a 4 MiB file, a NUL run, a bidi-spoofed heading, an import cycle | symlink confinement (`isInside` + `realOrSelf`); `sourceReadCapBytes`; binary sniff; bidi strip at write; depth-4 cycle detection |
| **A race against the human's review** | edits a source between the report and `y` | **source re-verification [G1.1]** |
| **A concurrent JevCode** | a second apply, undo or resume | **the widened lock [G1.4]** |
| **The agent itself, mid-run** | writes to its own memory to steer the next step | seatbelt write denies on `<ws>/.jevcode/{memory,rules,commands}` (§2.11) + the run-start rule pin **[G2.8]** |
| **A leak through the decider** | a body or a secret in a Jev request | metadata-only state; group V narrowed **[G2.4]**; the leak gate inspects captured request bodies |
| **A leak through artefacts** | a secret in the report, plan, index or history | no type carries a value; write-time redaction; the leak gate |

### A.2 The invariant list, as assertions

```
∀ row ∈ plan.rows        : row has no field of type "value"
∀ file ∈ artefacts       : ¬∃ needle ∈ (fixtureSecrets ∪ 15 families) . needle ⊂ file
∀ req  ∈ jevRequests     : ¬∃ body ∈ sourceBodies . body ⊂ req      ∧  req.bytes ≤ jevStateCap
∀ row  ∈ applied         : isInside(realpath(dirname(row.dest)), destinationRoot(row.scope))
∀ row  ∈ applied         : sha256(read(row.source.path)) === row.source.sha256
∀ srv  ∈ mcp.servers     : srv.enabled === false
∀ key  ∈ permissionKeys  : bytesWritten(key) === 0
∀ seg  ∈ executableSegs  : rendered(seg) startsWith "```text (not run)"
∀ k    ∈ credentialsApplied : k ∈ CREDENTIAL_KEYS ∧ consent(k) === 'tty'
```

Each line is one gate in §8.3.

### A.3 What the importer never does

No network request of any kind (not even to resolve an `instructions[]` URL, an MCP `url`, or an OAuth
metadata document). No shell execution. No write outside `~/.jevcode/imports/<id>/` before approval. No read
of a path whose basename `isSecretBasename` accepts. No read of a transcript body. No copy of a credential
value into any file other than the 0600 credential store, and only after a per-key TTY confirmation.

---

## Appendix B — `IMPORT_LIMITS`

Additive export in the `src/core/limits.ts` that `CD` row 3 creates **[G2.2]**.

```ts
export const IMPORT_LIMITS = {
  // discover
  walkDepth: 8,
  walkEntries: 20_000,
  walkMs: 2_000,
  filesPerRow: 512,
  sourceReadCapBytes: 4 * 1024 * 1024,        // = INSTRUCTIONS_READ_CAP_BYTES
  transcriptScanBytes: 256 * 1024,
  binarySniffBytes: 8 * 1024,
  readSlackBytes: 64 * 1024,                  // stat→read race (§6 row 31)

  // destination
  memoryDirBytes: 512 * 1024,
  memoryFiles: 200,
  memoryIndexLines: 200,
  memoryIndexBytes: 8 * 1024,
  topicBytes: 8 * 1024,
  ruleBytes: 4 * 1024,
  commandBytes: 8 * 1024,
  agentsAppendBytes: 8 * 1024,                // AGENTS.md stays under INSTRUCTIONS_MAX_BYTES
  rulePatterns: 200,
  ruleFiles: 200,                             // [G1.6]
  mcpServers: 64,
  slugMaxChars: 64,                           // [G1.2]

  // prompt (shares of the step's context budget) [G2.7]
  memoryIndexPromptBytes: 8 * 1024,
  rulesInScopeShare: 0.10,  rulesInScopeMin: 2 * 1024,  rulesInScopeMax: 12 * 1024,
  memoryInScopeShare: 0.14, memoryInScopeMin: 2 * 1024, memoryInScopeMax: 16 * 1024,

  // jev
  jevRequests: 3,
  jevQuestions: 400,
  jevHeadings: 5,
  jevHeadingCells: 80,
  jevSentenceChars: 200,                      // only under --jev-sample=head400 [G2.4]

  // plan
  planRows: 2_000,
  dedupePairs: 20_000,                        // [G1.6]
  minhashBands: 8,

  // artefacts
  reportBytes: 1 * 1024 * 1024,
  sourceLineBytes: 2 * 1024,
  importsKeep: 10,                            // [G1.4]
  lockStaleMs: 10 * 60 * 1000,
} as const;
```

---

## Appendix C — Decision-log entries, ready for `docs/DECISIONS.md`

**2026-09-21 Import is one command with a dry-run report; the report is the plan.**
`jevcode import` writes nothing outside `~/.jevcode/imports/<id>/`; `--yes` (or the overlay's `y`) applies
exactly the rows the report showed, **by row id**. Alternative considered: a wizard-driven per-tool import,
as Claude Code's own `/import [codex|gemini|cursor]` does. Rejected: nine sources × four classes cannot be
reviewed three rows at a time, and a per-tool loop makes cross-tool dedupe impossible — on this machine one
`AGENTS.md` is reachable by five detectors.

**2026-09-21 Jev answers only literal facts, inside a band a code rule declares, from metadata only.**
Five question groups, each with a total code rule, an explicit abstention band and a conservative fallback.
Jev never receives a file body or a candidate secret's bytes, may promote a value into the secret class and
may never demote one out of it. Alternative considered: Jev classifies every file. Rejected on cost, privacy,
and the principle that a decider which can overturn a confident code verdict must be right.

**2026-09-21 A JevCode memory is a provenance-stamped markdown file; the index is always on, topics are on
demand.** `AGENTS.md` + `MEMORY.md` in the system prompt; `rules/` and topic files in the per-step prompt
after `kept`, sized as shares of the context budget. Forced by `engine.ts:660` — the system prompt is built
once per run, so nothing path-scoped can live in it. Alternative considered: append everything to
`AGENTS.md`. Rejected: it loses scope and conditionality, blows the 32 KiB cap, and manufactures
contradictory always-on instructions.

**2026-09-21 Secrets are classified per key, never copied, except the two keys JevCode itself uses, on
per-key TTY confirmation.** `--yes` can never confirm a credential row. Everything else travels as an
env-var name and a `${VAR}` reference. `~/.claude/settings.json` on the author's machine is the worked
example: one file, three classes.

**2026-09-21 Imported content arrives inert, and the sandbox learns about memory.** Shell segments fenced,
hooks and `.js` workflows report-only, MCP servers `enabled: false`, permission grants never written. The
seatbelt gains write denies on `<ws>/.jevcode/{memory,rules,commands}` beside the `.git` ones, and a
`memory-local` read deny **emitted after the `(allow file-read* <roots>)` line** — an `addRead` deny would be
overridden by the workspace re-allow.

**2026-09-21 The plan is verified at apply, and destinations are confined.** Every row re-hashes its source
immediately before the write and is demoted to `review` on mismatch; every destination basename goes through
`slugOf` and an `isInside` assertion, and a symlinked destination is refused. Without the first, "sha256-
pinned" is advisory; without the second, a cloned repo's frontmatter `name:` can write into `.git/hooks`.

---

## Appendix D — Every user-visible string this design adds

| Group | Count | Where |
| --- | --- | --- |
| `[import]` items | 17 | §5.5, built in `src/config/imports.ts` |
| wizard step | 7 (wide, narrow, SR ×3, hint ×2) | §5.1 |
| overlay hints | 7 | §5.2 |
| conflict + credential prompts | 6 | §5.3, §5.4 |
| report section heads | 12 | §4.6.2 |
| action words | 5 + 17 `skip:*` + `suggest` (14 of the skips are the "unknown" reasons of §4.4.0) | `PlanRow.action` |
| `/memory` replies | 6 | §5.8.2 |
| `--plain` prompts | 4 | §5.7 |
| notices | 11 | walk caps, clips, cycles, stale lock, manifest upgrade, retention GC |

Two strings are **reused verbatim** rather than invented:
`error: /import runs when the run is idle; Esc pauses first` (`registry.ts:600`) and the oversize wording of
`instructions.ts:143`. One is new but parallel to an existing line:

```
MEMORY_NOT_TRUSTED_LINE = 'memory not loaded: workspace not trusted (run interactively once, or pass --trust-workspace)'
```

beside the existing `INSTRUCTIONS_NOT_TRUSTED_LINE`. Every string has an `--ascii` twin through
`asciiTwins()` (`glyphs.ts:223`) and an SR twin where it is a choice.

---

## Appendix E — Graft ledger

| Graft | Source | Landed in | Gate |
| --- | --- | --- | --- |
| **G1.1** verify the source pin at apply, not just record it | judgement 1 | §4.7.2, §4.9, §5.5, §7.4 row 29 | `import-source-toctou.test.ts`; §1 property 7 |
| **G1.2** sanitise and confine every destination path (`slugOf`, `isInside`, no-follow) | judgement 1 | §2.3, §4.7.3, §6 row 72, Appendix B `slugMaxChars` | `import-slug-escape.test.ts`; §1 property 8 |
| **G1.3** key the manifest by workspace; add the absent-destination matrix cell | judgement 1 | §2.2, §4.6.1 `workspaceKey`, §4.7.5, §6 rows 68–70 | `import-twice.test.ts` (clone + deleted destination) |
| **G1.4** widen the lock to undo and resume; missing pre-image is a row; add retention | judgement 1 | §4.7.1, §4.7.6, §6 rows 75, 77, Appendix B `importsKeep` | `lock.test.ts`, `undo.test.ts` |
| **G1.5** extend the trust re-pin rule to `update`, not only `append` | judgement 1 | §4.7.5, §7.4 row 35 | `trust.test.ts` (two new rows) |
| **G1.6** bound the plan phase (minhash buckets, `dedupePairs`, `ruleFiles`); decide case-sensitivity per volume | judgement 1 | §2.5, §2.8, §4.2.2, §4.5, §6 rows 16, 18, 64, §8.5 | `perf/import.ts` row 3; `discover.test.ts` |
| **G2.1** emit the `memory-local` read deny **after** the `(allow file-read* …)` line | judgement 2 | §2.11, §7.4 row 32, Appendix C | `seatbelt.test.ts` ordinal assertion |
| **G2.2** state the W0 ordering against the coordination plan (`limits.ts`, types contract line, prompts row 19, `kept`) | judgement 2 | §2.10.6, §7.1, Appendix B header | the build order itself; `limits.test.ts` |
| **G2.3** correct the redact-family count 16 → 15 | judgement 2 | §1 property 4, §4.4.2 rule 3, §9.1 | `import-leak.test.ts` needle list |
| **G2.4** shrink group V's Jev payload to headings + noun phrase + polarity markers | judgement 2 | §4.4.3 group V, Appendix B `jevSentenceChars` | `questions.test.ts` payload assertion |
| **G2.5** make the overlay's common path one key; per-row behind `Enter`-expand | judgement 2 | §5.2 | `import-reducer.test.ts`, pty `r4-import-overlay` |
| **G2.6** restate property 1 as "writes only under `~/.jevcode/imports/<id>/`", in the report footer too | judgement 2 | §1 property 1, §4.6.2 header line, §5.7 | `import-dryrun-writes-only-artifacts.test.ts` |
| **G2.7** express the two per-step budgets as shares of the context budget | judgement 2 | §2.8, §2.10.3, Appendix B | `limits.test.ts`, `context.test.ts` |
| **G2.8** add the mid-run reload race as a corner case, and pin the rule set at run start | judgement 2 | §2.12, §6 rows 94–95 | `session.test.ts`, `engine.test.ts` |

Both judgements' remaining line-number corrections are folded into §9.1, including the two that were
themselves wrong.

---

*End of `docs/IMPORT-DESIGN.md` — written 2026-09-21 against `5a167b2`.*
