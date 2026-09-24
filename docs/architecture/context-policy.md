# The relaxed context

> **The context of the Jev-driven modes.** The default mode, `agent`, keeps one append-only
> conversation per session instead, with tool output capped and spilled, stale results masked at
> 50 % of the budget and a summary compaction at 85 %; see
> [The agent loop](agent-loop.md#context). The `context.*` settings below apply to the legacy
> modes, except `context.compaction`, whose effective default in agent mode is `llm`.

There are two windows in a run, not one, and keeping them apart is the whole design.

**Jev's window is fixed and small.** The decider sees the four most recent steps, with each
step's output clipped to 400 characters of head plus 200 of tail. It does not grow with the
transcript, so no Jev request gets slower or more expensive as a run goes on.
<!-- WINDOW_SIZE = 4, WINDOW_OUTPUT_HEAD = 400, WINDOW_OUTPUT_TAIL = 200: src/loop/window.ts:10-12 -->

**The generator's window is relaxed.** It gets a tiered history, a file cache re-read from disk
every step, whole command outputs spilled to files, a rolling summary, and a deterministic
compactor. That is what `src/loop/context/` is.

The normative text is [`docs/COORDINATION-DESIGN.md` §8](../COORDINATION-DESIGN.md). This page
is the built shape.

## The budget

`contextBudget` derives one number, `budgetChars`, from two terms and takes the smaller:

| term | formula |
|---|---|
| the window term | `windowTokens × 3.4 × 0.55` |
| the money term | `(spendCapUsd × 0.5) / (maxSteps × inputPerM) × 1e6 × 3.4` |

then clamps to `[60,000, 800,000]` characters, and finally clamps again to 90 % of the model's
own window if that is smaller — recording `windowTooSmall` when it does.
<!-- src/loop/context/limits.ts:60; constants in src/core/limits.ts:13-25 -->

| constant | value |
|---|---:|
| `CHARS_PER_TOKEN` | 3.4 |
| `DEFAULT_GENERATOR_CONTEXT_TOKENS` | 128,000 |
| `CONTEXT_BUDGET_SHARE` | 0.55 |
| `CONTEXT_BUDGET_SPEND_SHARE` | 0.5 |
| `CONTEXT_BUDGET_MIN_CHARS` | 60,000 |
| `CONTEXT_BUDGET_MAX_CHARS` | 800,000 |
| `CONTEXT_BUDGET_WINDOW_MAX_SHARE` | 0.9 |

The money term is not decoration. A 240,000-character prompt is roughly 70,000 input tokens. On
a cheap model that is fractions of a cent per step. On a model at a few dollars per million
input tokens it is over a tenth of a dollar per step, and a default run cap would be spent on
prompt input alone before the run got far. The result carries `boundBy` — `window`, `money`,
`floor` or `ceiling` — so a run can say which term bound it rather than leaving it to be
inferred.

The character count is an estimate throughout. The generator's own tokenizer is never called;
3.4 characters per token is the constant everything uses.

## The fill order

Sections are added in a fixed order, and a section that does not fit shrinks to its floor before
the next one is added:

task → plan → directives → kept items → **files in view** → **recent steps** → summary → other
sessions → candidates.

| section | share or cap |
|---|---|
| files in view | 40 % of the budget |
| recent steps | 30 % of the budget |
| kept items | at most 24 items of 300 characters |
| rolling summary | 6 KiB in the prompt; the summary text itself at most 3 KiB |
| other sessions | 5 % of the budget, capped at 6 KiB |

<!-- FILES_SHARE, HISTORY_SHARE, KEPT_MAX_ITEMS, KEPT_ITEM_CHARS, SUMMARY_MAX_CHARS,
     OTHER_SESSIONS_SHARE, OTHER_SESSIONS_MAX_CHARS, SUMMARY_TEXT_MAX_CHARS: src/core/limits.ts:67-113 -->

Files come before history deliberately: a bigger history crowds out the file views, and the file
views are what stop the generator re-reading the same file every step.

## Tiered history

`src/loop/context/history.ts` keeps at least 12 recent steps, in four tiers:

| tier | entries | what is shown |
|---|---|---|
| whole | the newest 2 | up to 32 KiB of the step's output — head 24k plus tail 8k |
| clipped | the degradation step below whole | head 12k plus tail 4k |
| mid | entries 3 to 6 | head 4k plus tail 2k |
| one-line | entries 7 to 12 | one line naming the action, the outcome and the character count |

<!-- HISTORY_STEPS=12, HISTORY_WHOLE=2, HISTORY_WHOLE_HEAD/TAIL=24k/8k,
     HISTORY_CLIPPED_HEAD/TAIL=12k/4k, HISTORY_MID=6, HISTORY_MID_HEAD/TAIL=4k/2k:
     src/core/limits.ts:29-40 -->

The important part is the order of operations. **The fit is computed before the read.**
`planHistory` costs every entry from a character count already stored on it and degrades entries
down the ladder — whole, clipped, mid, the 600-character body, the one-liner — oldest first,
until the 30 % allowance holds. Only the tiers that survive are ever opened from disk. So a
history the budget cannot show costs no file reads at all, and the newest entry survives
longest.

`state.json` stays small because the long text is not in it. Every command or file output longer
than 600 characters is written whole and redacted to `outputs/step-<n>.txt` in the run
directory, at most 1 MiB per file and 64 MiB per run. The generator can ask for the rest through
a pseudo-path, `jevcode:outputs/step-<n>.txt`, served from the run directory.

That 600-character threshold **is** the window's body cap, and that is the point. An earlier rule
spilled only outputs above 12 KiB, so everything between 601 characters and 12 KiB — a test
tail, a small file — had neither a file nor a body, and the generator saw exactly the clip that
caused the structural re-read loop the relaxed context exists to remove.

## Files in view

`src/loop/context/context-cache.ts` keeps two maps:

- **`fileCache`**, at most 16 entries: every path the generator read, edited, wrote, patched,
  mentioned, or Jev kept. Each carries who pinned it and when it was last used. At prompt build
  the engine **re-reads each cached file from disk** — fresh content, at most 32 KiB per file,
  and a windowed view centred on the last edited region when the file is larger — up to the
  40 % share and up to 96 KiB of reads per step. Eviction is least-recently-used, with pins
  ordered human, then Jev, then edit, then read.
- **`fileMemory`**, at most 64 entries: a short hash, a size, and when the file was last read and
  last edited. It is filled at commit from hashes the image writer already computed, so it costs
  no second read.

<!-- FILE_CACHE_MAX_ENTRIES=16, FILE_MEMORY_MAX_ENTRIES=64, FILE_VIEW_MAX_CHARS=32 KiB,
     FILE_CACHE_BYTES=96 KiB: src/core/limits.ts:50-55 -->

`fileMemory` buys one specific thing: a `read` of a file whose size and modification time are
unchanged, and whose content is already in view, executes at **zero cost** and returns a line
saying so. It still counts as a step for the loop detector, which is the right outcome — three
identical reads in a row should still trip.

The `read` action's own caps rise with the relaxed context: at most 16 paths per action, 32 KiB
of any one file, 128 KiB across the action.
<!-- READ_MAX_FILES, READ_MAX_FILE_CHARS, READ_MAX_TOTAL_CHARS: src/core/limits.ts:60-65 -->

In `jev-on`, Jev's context stage still selects the files it selects; the cache is merged and
de-duplicated by path, with Jev's picks first.

## Nothing is truncated silently

Every clip carries the path to the rest:
`…[N chars omitted; full text: read jevcode:outputs/step-7.txt]`, or
`[lines 120–260 of 900; read src/x.ts for the rest]`.

An output reference whose file is missing renders a line that names **why** it is missing,
because there are two causes and they mean different things: the run-directory budget evicted
it, or the file was never written.

## Compaction

`src/loop/context/compaction.ts` is pure, free and deterministic: the same inputs produce the
same summary text, byte for byte. There is no clock inside it — the timestamp is an input.

It writes a rolling summary with fixed sections — objective, completed, active, blocked, files,
tests, notes — of at most 3 KiB, and collapses every history entry older than the newest two to
its one-line facts, each keeping a pointer to its whole output on disk.

| setting | values | default |
|---|---|---|
| `context.mode` | `relaxed`, `legacy` | `relaxed` |
| `context.compaction` | `code`, `llm`, `off` | `code` |
| `context.compactEvery` | an integer; 0 disables the interval trigger | 8 |
| `context.historySteps` | an integer | 12 |
| `context.fileCacheBytes` | bytes | 98,304 |
| `context.budgetChars` | characters | derived, as above |

<!-- src/config/defaults.ts:44-48 and :159-164 -->

A compaction is due when any of three things holds, evaluated by the engine at the commit of the
triggering step: every `compactEvery` steps, or the built prompt reached 85 % of the budget, or
a manual request.
<!-- COMPACT_EVERY=8, COMPACT_AT_PCT=85: src/core/limits.ts:108-110 -->

One further switch, `context.kept`, decides only who **orders** the kept items — extraction is
always code. `'code'`, the default, asks nothing and is therefore deterministic across machines
and resumes and available with the decider off. `'jev'` spends one bounded request per
compaction, is refused when the decider is off, and falls back to the code order on an escape or
any failure.
<!-- src/core/types.ts:2464-2473 -->

## The meter

`src/loop/context/meter.ts` computes one object, `ContextUsage`, at exactly two points: after a
step's prompt is built, and after a compaction. The module is pure; the engine keeps the last
object and hands it back unchanged.

| field | meaning |
|---|---|
| `promptChars`, `budgetChars`, `pct` | the assembled prompt against its budget |
| `tokensInWindow`, `budgetTokens`, `windowTokens` | the same three in estimated tokens, at 3.4 characters each |
| `budgetBoundBy` | `window`, `money`, `floor` or `ceiling` |
| `usdPerStep` | estimated generator input cost per step at this budget, or null when the generator is unpriced |
| `windowTooSmall` | the budget was clamped to the model's own window |
| `files`, `historyEntries`, `summaryAt` | what the last build actually contained |
| `recentSteps` | how the history tiers degraded — how many whole, clipped, one-line |
| `compactions`, `lastCompactionAt`, `lastCompactionStep`, `compaction` | the compaction ledger |
| `promptBuildMs`, `refreshMs` | how long the last build and its file refresh took |

<!-- src/core/types.ts:2362 ContextUsage; src/loop/context/meter.ts -->

`pct` is a share of the **budget**, not of the model's window — the budget is already 55 % of
the window by default, so the two numbers are not interchangeable. The amber threshold is 85 %
and the red threshold is 95 %.
<!-- METER_AMBER_PCT, METER_RED_PCT: src/core/limits.ts:112-113 -->

The object reaches `EngineStatus.context` and is persisted with the run, so a resumed run does
not restart its compaction count at zero. The design specifies `/context` and `/compact`
commands to surface and trigger it; the interactive command list in this tree does not carry
them yet.
<!-- EngineStatus.context: src/core/types.ts:2063. `grep "name: '" src/tui/commands/registry.ts`
     lists no `context` or `compact` command at the time of writing. -->

## The escape hatch

`context.mode: legacy` is the byte-identical escape. It restores the prompt the harness built
before the relaxed context: the same window, the same prompt bytes. It exists so that a
regression in the relaxed policy is one setting away from being ruled out, and so that a
comparison between the two is a comparison and not a rebuild.
<!-- CONTEXT_VIEWS = ['relaxed', 'legacy'], DEFAULT_CONTEXT_VIEW = 'relaxed': src/config/defaults.ts:44-46;
     ContextPolicyOptions.view: src/core/types.ts:2456 -->

Jev's window is unaffected by either setting. It is four steps of 400 plus 200 characters in
every mode, which is the sentence this page started with.
