# Round 4 — Topic A6: the file-edit surface

**"File edits look the cleanest without missing anything; handle all edge and corner cases."**

Measured 2026-09-21 against the last committed tree `ec61170` in a throwaway worktree
(`/tmp/jevcode-r4-fileedit`, `npm run -s build`, driven with `scripts/pty/drive.exp` at 24×80 with a temp
`JEVCODE_HOME` and a temp git workspace copied from `examples/demo-py`). Nothing in the main checkout was
built, run or edited. Every file:line below is `ec61170`.

Captures produced for this report (in this directory):

| file | what it holds |
| --- | --- |
| `file-edit-review-write-24x80.cap` / `.jsonl` | `JEVCODE_MOCK_REVIEW_AT=1` — the review card for a `write` action, `e` pressed, then `y`; the `[step 1]` row after apply |
| `file-edit-review-edit-diff-24x80.cap` / `.jsonl` | `JEVCODE_MOCK_REVIEW_AT=4` — the review card for an `edit` action, then `/diff` on the finished run |

---

## 1. What exists today (read, not assumed)

### 1.1 The engine's shapes

| shape | file:line | what it carries |
| --- | --- | --- |
| `Action` `edit` | `src/core/types.ts:24` | `{ path, old, new }` — exact unique match, no line numbers |
| `Action` `write` | `src/core/types.ts:25` | `{ path, content }` — whole file |
| `Action` `patch` | `src/core/types.ts:26` | `{ diff }` — one unified diff string, `-p1`, applied with `git apply` |
| `ActionOutcome` `executed` | `src/core/types.ts:193` | `{ exec?, summary, changedFiles: string[] }` — **no per-file `+a −b`, no status letter, no rename source** |
| `ActionOutcome` `failed` | `src/core/types.ts:197` | `{ error: string }` — one string |
| apply | `src/workspace/patch.ts:163–200` | `git apply --check` then `git apply`; **never `--reject`, never `--3way`** → a failing patch is atomic, there is no partial apply and there are no reject files |
| failure text | `src/workspace/patch.ts:203–206` `gitFirstError` | only the **first** `error:` line of git's stderr survives; the full stderr goes into `PatchError`'s second argument and is then dropped at `src/loop/engine.ts:2716` (`error: this.redact(err.message)`) |
| execute summaries | `src/loop/stages/execute.ts:85,91,104` | `edit applied to <path> (1 match)` · `created\|overwrote <path>` · `patch applied (N file(s))` — **the patch summary names no file** |

### 1.2 The one formatter (`src/tui/plain.ts`)

| function | line | behaviour |
| --- | --- | --- |
| `describeAction('edit')` | `:163` | `target = a.path`, `preview = "--- old\n<old>\n+++ new\n<new>"` — **two whole blobs, not a diff** |
| `describeAction('write')` | `:164` | `target = a.path`, `preview = a.content` — the whole file |
| `describeAction('patch')` | `:165–168` | `target = "<N> line unified diff"`, `preview = a.diff` — **no path is ever computed for a patch** |
| `clipDetail` | `:182–187` | `TRANSCRIPT_DETAIL_MAX_LINES = 60` (`:111`), `TRANSCRIPT_DETAIL_MAX_CHARS = 6000` (`:112`); CR/CRLF normalised, control chars stripped (`CONTROL_RE :118` keeps `\t`) |
| `outcomeText('executed')` | `:196–203` | `outcome executed: <summary> (<flags>) changed=<n>: <≤5 paths>` |
| `stepOutcomeText` | `:446–449` | the visible `[step N]` row's outcome segment is just `"<n> file(s)"` — **no names, no counts** |
| `itemsFromEvent('proposal')` | `:321–326` | `proposal <kind> <target>: <goal> \| plan …`, `detail = clipDetail(preview)` |
| `confirmPreviewLines` | `:534–539` | `clipDetail(describeAction(action).preview).split('\n')` |
| `formatTranscriptItem` | `:487` | `label + ' ' + text` — **`detail` is never part of it** |
| plain renderer `handle`/`notify` | `:954`, `:981–990` | writes `formatTranscriptItem(item)` only → **`detail` never reaches `--plain`, `--json` or `transcript.log`** (declared TUI-only at `docs/TUI-DESIGN.md:1597`) |

### 1.3 The review card (`src/tui/review/lines.ts`, `src/tui/Review.tsx`)

* `reviewCardTitle` `review/lines.ts:124–134` → `review · step N · risk r (bnd) · <kind> <target> "<goal>"`.
* `reviewCardLines` `:143–161` → title edge, keys, ruler, 4 gauges, `5 matches_intent`, `previewRows` preview rows, bottom edge.
* `reviewPreviewLines` `:296–304` — preview indented two cells, cut to the granted rows, last granted row replaced by
  `previewTail(hidden)` = `…[k more preview lines · e expands]` (`:291`).
* `Review.tsx:135–139` (flat) and `:183` (card) paint **every** preview row with `textProps(theme, 'dim', color)`.
* `src/tui/theme.ts:57` — the `ColorRole` union has no `added` / `removed` / `hunk` / `meta` member. **No diff colour exists in the product.**
* `reviewScreenReaderLines` `review/lines.ts:278–288` — title, five aria rows, `1 approve / 2 decline / 3 …`, prompt.
  **No preview row at all.**
* The preview row budget is `CAP.preview = 8` (`src/tui/layout.ts:29`), lifted to the remainder by `e`
  (`layout.ts:181`, `App.tsx:1512–1513`).

### 1.4 `/diff`, `/undo`, `/rewind`

* `/diff` (no argument) → `diffStatBlockFromGit(...)` → `block(lines[0], lines.slice(1))` (`src/cli/session.ts:2332–2333`).
* `diffStatBlock` `src/undo/diff.ts:257–284`: header `diff (run <id> · N files · +a −b · c untracked · d binary · e skipped)`,
  rows ` M path  +a −b  <bar10>`, `†` legend, skipped rows, `… N more files (/diff --all)` past `DIFF_ROW_CAP = 40`,
  then **`lines.map(l => truncateRightCells(l, cols))` — the header is truncated too** (`:283`).
* `/diff <step>` → `diffStepLines` `src/undo/diff.ts:513–558` — a real unified diff per file from the checkpoint images,
  with `/dev/null` sides, `Binary files differ`, `(files > 1 MiB…)`, `(no pre-image…)`, `(changed since)`,
  capped at `DIFF_INLINE_MAX_LINES = 400`.
* `unifiedDiff` `src/undo/diff.ts:441–489` already produces correct git-shaped hunks with `\ No newline at end of file`.
  **It is used only by `/diff <step>` and `--full`; the review card and the proposal item never call it.**
* `/diff --full` → `collectFullDiff` + `openFullDiff` (`src/undo/pager.ts:241`); no pager → `pagerUnavailableNotice`
  (`pager.ts:36`) + the same inline block; `--plain` refuses `--full` (`src/tui/plain-composer.ts:52`).
* `/undo` → `undoSummaryLine` `src/undo/plan.ts:315–323` — **one line** `undo step N: restored 3 files (a, b, c), skipped 1 (d: reason)`.
* `/rewind` picker rows → `rewindPickerRows` `src/undo/plan.ts:389` = `s<N>   <n> files  <pathList>` truncated to `columns`.
* `block()` `src/cli/session.ts:1215–1222`: TUI → **one item + `detail`**; every other renderer → **one `[ui] <line>` item per line**.
* `columns()` `src/cli/session.ts:1143` = the terminal width, with **no allowance for the `[ui] ` label**.

---

## 2. Measured frames

### 2.1 The review card for `write`, 24×80 (`file-edit-review-write-24x80.cap`, frame 14)

```
╭─ review · step 1 · risk 0.50 (exp) · write scratch_0.py "Create scratch_0.… ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension        lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)  │
│ 1 destructive    L2  █████·····  0.50 exp  1.00  loses untracked pre-existi… │
│ 2 out_of_scope   L0  ··········  0.00 tail 0.96  directly does what `plan.r… │
│ 3 plan_mismatch  L0  ··········  0.00 tail 0.96  matches `intent` and the p… │
│ 4 irreversible   L0  ▏·········  0.01 exp  0.96  no lasting effect, or rest… │
│ 5 matches_intent     █████████·  0.90 noul 0.80~ the action is an instance … │
│   VALUE_0 = 0                                                                │
│                                                                              │   ← blank preview row
╰──────────────────────────────────────────────────────────────────────────────╯
```

Nine of the eleven body rows are risk gauges; the change itself is one unindicated row and a blank one.
Nothing says "new file", nothing says "+1 −0". The title's goal quote is cut without its closing `"`.
Frames 14→17 are byte-identical apart from the clock: **`e` (expand) changed nothing and said nothing**
(`layout.ts:181` already granted all of `previewWant = 2`).

### 2.2 The review card for `edit`, 24×80 (`file-edit-review-edit-diff-24x80.cap`, frame 23)

```
╭─ review · step 4 · risk 0.50 (exp) · edit scratch_0.py "Edit scratch_0.py" ──╮
…
│   --- old                                                                    │
│   VALUE_0 = 0                                                                │
│   +++ new                                                                    │
│   VALUE_0 = 3                                                                │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The preview *looks* like a unified diff header and is not one: there is no `-`/`+` on the content lines,
no line numbers, no context, and with `NO_COLOR` (or with any theme, since every preview row is `dim`)
the removed and added lines are typographically identical.

### 2.3 The step row after apply (`file-edit-review-write-24x80.cap`, frame 20)

```
[step 1] write scratch_0.py "Create scratch_0.py" · risk 0.50 [review] · 1 file
         · judge 0.90 · 3.2s · $0.0002
```

`1 file` — never *which* file, never `+a −b`, never a `/diff 1` hint. The `outcome` item that does carry
`changed=1: scratch_0.py` is in `COMPACT_HIDDEN_KINDS` (`src/tui/useEngine.tsx:64`), so the default TUI
never shows it. Confirmed in the `--plain` twin, which does print it:
`[step 1] outcome executed: created scratch_0.py changed=1: scratch_0.py`.

### 2.4 `/diff` after the run (`file-edit-review-edit-diff-24x80.cap`, frame 39; raw bytes verified)

```
[ui] diff (run 20260922-035620-lasgmyap · 2 files · +2 −0 · 2 untracked · 0
     binary ·…
 ? scratch_0.py                                          +1 −0      ++++++++++
 ? scratch_4.py                                          +1 −0      ++++++++++
```

`grep -c skipped` over the whole capture = 1, and that one hit is an unrelated `[step 6]` row: **the string
`0 skipped)` is never written.** The header is 89 cells, `diffStatBlock` cuts it to `columns` (80) at
`src/undo/diff.ts:283` *before* the `[ui] ` label is prepended, so the tail is destroyed **and** the row still
wraps to two rows. The rows below start at column 0 while the head starts at column 5.

### 2.5 Unit-level probe of a real multi-file patch (`reviewCardLines(req, 12, 8, 80)`)

```
 0|╭─ review · step 4 · risk 0.50 (exp) · patch 18 line unified diff "fix the o… ─╮
 …
 8|│   diff --git a/calc/ops.py b/calc/ops.py                                     │
 9|│   index 1111111..2222222 100644                                              │
10|│   --- a/calc/ops.py                                                          │
11|│   +++ b/calc/ops.py                                                          │
12|│   @@ -1,6 +1,7 @@                                                            │
13|│    def add(a, b):                                                            │
14|│   -    return a - b                                                          │
15|│ …[11 more preview lines · e expands]                                         │
16|╰──────────────────────────────────────────────────────────────────────────────╯
```

Six of the eight granted preview rows are diff plumbing. One removed line is visible, its `+` twin is not,
and the second file of the patch is invisible. The title says `patch 18 line unified diff` — **no path**.

Other probe outputs (same harness):

| input | result |
| --- | --- |
| `write` content `"X = 1\n"` | `confirmPreviewLines` = `["X = 1",""]` — **always a trailing blank row** (contradicts `review/lines.ts:295` "never a blank row inside a granted preview") |
| `edit` old/new of 2 lines each | `["--- old","X = 1","Y = 2","+++ new","X = 9","Y = 2"]` — `previewWant` is `old + new + 2`, so a 200-line edit asks the layout for 402 rows |
| diff with `\t`, CRLF, BOM, trailing spaces | `["-\tolder line   ","+﻿newer\tline\t"]` — CRLF is normalised (good); **tabs, the BOM and the trailing spaces pass straight through** |
| 5 000-line patch | `describeAction.target` = `5000 line unified diff`; `confirmPreviewLines` = 61 rows ending `…[4940 lines omitted]`; the card then says `…[N more preview lines · e expands]` — **`e` can only ever reveal 61 of the 5 000** |
| one 400-char added line | rendered as one card row cut with `…`; no indication of how much was cut |

---

## 3. Defects (evidence-backed)

| # | severity | defect | evidence |
| --- | --- | --- | --- |
| **A6-1** | H | A `patch` proposal **never names a file**. Title, `[step N]` row, `transcript.log`, `--plain`, `/copy proposal` all read `patch <N> line unified diff`. | `plain.ts:165–168`; §2.5 probe |
| **A6-2** | H | The `edit` preview is **not a diff**: `--- old` / blob / `+++ new` / blob, no signs, no line numbers, no context, no alignment. Under `NO_COLOR` (and today under every theme, §A6-3) the two sides are indistinguishable. | `plain.ts:163`; capture §2.2 |
| **A6-3** | H | **No diff colour exists.** `ColorRole` has no added/removed/hunk/meta member; `Review.tsx:136,183` paints every preview row `dim`; `Transcript.tsx:127–131` paints every detail row `dim`. Only git's own colours inside the `--full` pager are ever coloured, and those bypass the theme. | `theme.ts:57`; `Review.tsx:136,183`; `Transcript.tsx:128` |
| **A6-4** | H | `/diff`'s header is truncated to `columns` **before** the `[ui] ` label, so `0 skipped)` is destroyed at 80 columns, and the row wraps anyway. | `undo/diff.ts:283`; capture §2.4 (`skipped` absent from the capture) |
| **A6-5** | H | `/diff --all` is documented as "lift the 40-row cap" but the TUI clips the block to **60 detail lines** (`clipDetail`), and `/diff <step>`'s own 400-line cap is likewise clipped to 60 with different wording. Two caps, the silent one wins. | `registry.ts:197`; `plain.ts:111,184`; `session.ts:1216` |
| **A6-6** | H | The visible post-apply row says `1 file` and nothing else. The row that names the files (`outcome`) is hidden in the default compact transcript. There is no `/diff <n>` affordance anywhere on the edit path. | `plain.ts:446–449`; `useEngine.tsx:64`; capture §2.3 |
| **A6-7** | M | Screen-reader review **omits the preview entirely** — an SR user is never read a single line of the change they are approving. | `review/lines.ts:278–288` |
| **A6-8** | M | The review card burns 6–7 of its 8 preview rows on `diff --git` / `index` / `---` / `+++` / `@@` plumbing before the first changed line; a multi-file patch shows only the first file. | §2.5 |
| **A6-9** | M | `write` previews always end with a blank row (content ends `\n` → `split('\n')` trailing `''`), inside a card that documents "never a blank row inside a granted preview". | `plain.ts:538`; `review/lines.ts:295`; capture §2.1 row 11 |
| **A6-10** | M | `e` (expand) is a **silent no-op** when `previewWant ≤ CAP.preview`: no frame change, no toast. Captured frames 14→17 are identical. | `layout.ts:181`; `App.tsx:1512`; capture §2.1 |
| **A6-11** | M | `…[k more preview lines · e expands]` counts only the post-`clipDetail` lines. On a 5 000-line patch it promises 61 and 4 939 lines can never be reached from the card. | `review/lines.ts:291,302`; §2.5 probe |
| **A6-12** | M | Tabs survive into fixed-width card rows. `cellWidth` treats `\t` as one cell; the terminal expands it to the next 8-column stop, so the card's right `│` shifts and the box breaks. Trailing whitespace and a BOM are likewise invisible, so a whitespace-only change looks like no change. | `plain.ts:118` (CONTROL_RE keeps `\t`); §2.5 probe row `-\tolder line   ` |
| **A6-13** | M | `patch applied (N file(s))` names no file; `edit applied to x (1 match)` gives no counts. A patch's own outcome summary is strictly less informative than an edit's. | `loop/stages/execute.ts:104` |
| **A6-14** | M | A failed patch shows **only git's first `error:` line**. git's diagnosis is normally two lines (`error: patch failed: f:12` *and* `error: f: patch does not apply`); the second, and the whole stderr held in `PatchError`'s detail, are dropped. No hunk, no file, no "what changed underneath". | `workspace/patch.ts:203–206`; `loop/engine.ts:2716` |
| **A6-15** | M | `/diff` (and `/rewind`'s picker block) rows are padded to the **full terminal width** and then drawn as indented detail rows. Today they sit at column 0 under a head at column 5. Round 3's D-L moves detail rows to **column 10** (`docs/TUI-DESIGN-3.md:1252,1271`) while `session.ts:2332` still passes `columns()`: **every `/diff` row will overflow by 10 cells and wrap.** | `session.ts:1143,2332`; `undo/diff.ts:283`; `TUI-DESIGN-3.md:1271` |
| **A6-16** | M | In `--plain` the same block prints **one `[ui] <row>` item per row** (`block()` else-branch), so each pre-padded, pre-truncated row gains a 5-cell prefix and the counts/bar columns no longer line up. | `session.ts:1215–1222` |
| **A6-17** | L | `diffBar` scales to the largest row, so when every file has the same churn every bar is a full 10 cells of `++++++++++` — pure noise. Captured. | `undo/diff.ts:203–219`; capture §2.4 |
| **A6-18** | L | The `/diff` header always prints `0 untracked · 0 binary · 0 skipped`, making it 89 cells and guaranteeing the wrap of A6-4; round 3 rule 8 wants `[ui]` heads ≤ 60. | `undo/diff.ts:199–201`; `TUI-DESIGN-3.md:1284` |
| **A6-19** | L | `outcome executed` for a `run` prints `exit 0 (exit 0, 8ms)` — the summary and the flag list duplicate the exit code. | `plain.ts:196–203`; `--plain` probe `[step 3]` |
| **A6-20** | L | `undoSummaryLine` is one unbounded line (`pathList` caps at `UNDO_LIST_MAX`, everything on one row) — a five-file undo wraps into a paragraph with no structure. | `undo/plan.ts:315–323` |
| **A6-21** | H (coverage) | `mockTrajectory` emits only `write`/`read`/`run`/`edit` — **no `patch` action anywhere in `--mock`**, so the patch review card, the patch title and the patch failure text have **zero pty coverage** and no TUI unit test (`grep -rl "kind: 'patch'" test/unit/tui` → nothing). | `cli/mock-trajectory.ts:39–42` |
| **A6-22** | L | The card title cuts the goal without its closing quote (`"Create scratch_0.… ─╮`), so every truncated title shows an unbalanced quote. | `review/lines.ts:133`; `card.ts` `cardTop`; capture §2.1 |

Two things that are **correct** and must not be broken: CRLF/CR is normalised by `clipDetail`
(`plain.ts:183`), and a failing patch is atomic — `git apply --check` runs first and `--reject` is never used
(`workspace/patch.ts:6–8,192–196`), so "partial apply" and "rejected hunks" are states the product **cannot**
enter. Any proposal must keep that guarantee rather than render a reject UI.

---

## 4. Proposals

Every proposal below states the identity classification against the round-3 rule
(`docs/TUI-DESIGN-3.md` §5.3): **colour/layout** = no transcript text changes, only the frame-identity
normaliser applies; **text** = the item string changes and the `--plain`/`transcript.log` twin and every pinned
test must change with it (this is exactly what D-M deferred to round 4).

---

### P1 — `fileEditSummary(action)`: one pure function that names the files of every edit action

**What changes.** A new pure module `src/tui/diff/summary.ts` exporting

```ts
export interface FileTouch { path: string; from: string | null; letter: 'M'|'A'|'D'|'R'|'B'; added: number; deleted: number }
export interface EditSummary { files: FileTouch[]; added: number; deleted: number; truncatedFiles: number }
export function editSummary(a: Action): EditSummary | null;   // null for read/run/done
export function editTargetText(s: EditSummary, cells: number, g: GlyphSet): string;
```

For `patch` it parses the diff headers with the **existing** parser shape used by
`src/workspace/patch.ts:81` (`parsePatchFiles`, already exported and pure; moved to a shared ink-free module —
today's file pulls in `node:fs/promises` only for the apply half) and counts `+`/`-` body lines per file; `new file mode` / `deleted file mode` /
`rename from|to` / `GIT binary patch` / `Binary files … differ` set the letter. For `edit` it runs
`lineDiffCounts(old, new)` (`src/undo/diff.ts:395`). For `write` it is `A` (or `M` when the engine already
knows the file existed) with `added = lines(content)`.

`describeAction('patch')` (`plain.ts:165`) becomes
`target = editTargetText(...)` = `calc/ops.py +12 −3, README.md +2 −0` at ≥ 3 files
`3 files +14 −3 (calc/ops.py, README.md, …)`; `describeAction('edit')` and `('write')` gain ` +a −b`.

**Where.** new `src/tui/diff/summary.ts`; `src/workspace/patch.ts` (export the header parser, no behaviour
change); `src/tui/plain.ts:157–172`.

**Edge cases.** (1) a diff with no parseable header → fall back to today's `"<N> line unified diff"`;
(2) `/dev/null` sides → `A` / `D`; (3) rename with 100 % similarity and no hunks → `+0 −0`, `R old → new`;
(4) copy (`copy from`) → treat as `A`; (5) mode-only change → `M +0 −0 (mode)`; (6) `GIT binary patch` →
`B`, counts suppressed, size if the `literal <n>` header carries it; (7) 200 files → first 3 named plus
`(+197)`, the whole `EditSummary` still carries them for the card; (8) quoted/UTF-8 paths → `unquote`
(`patch.ts:27–33`) already handles C-quoting; (9) a path with a `·` or a newline → `oneLine` + cell
truncation; (10) `+++ b/x` with a GNU-diff timestamp tab → `headerPath` already strips it (`patch.ts:44–52`);
(11) a diff whose `---`/`+++` disagree with `diff --git` → prefer the `+++` side, which is what `git apply`
uses; (12) 5 000-line diff → counting is O(lines), measured once at proposal time, not per frame;
(13) empty diff → `null`, caller keeps today's text.

**Tests.** unit `test/unit/tui/diff/summary.test.ts`: the twelve cases above, plus a property test that
`editSummary(patch).added` equals the count of `+` lines that are not `+++`. Unit `plain.test.ts`: the three
`describeAction` kinds. pty: A6-21's new `patch` step (see P8).

**Perf gate.** Pure, called once per proposal event and once per review frame; must not appear in the
composer path. `composer keystroke → frame p95 < 16 ms` unaffected (no call site in `Composer`/`resolveKey`);
`lag p95 < 5 ms` — the parse of a 4 MiB diff (`MAX_PATCH_BYTES`) must be memoised per `Action` identity
(a `WeakMap<Action, EditSummary>`), asserted by a unit benchmark at 5 000 lines < 5 ms.

**Identity: TEXT.** `proposal <kind> <target>` and the `[step N]` row change in all three sinks. Formatter:
`describeAction` in `src/tui/plain.ts`. Twins: the `--plain` renderer is the same function, so it follows
automatically; pinned tests to update — `test/unit/tui/plain.test.ts`, `test/unit/cli/session.test.ts`
(step-row assertions), `test/pty/smoke/*.steps` that grep `write scratch_`, `src/perf/pty.ts` step-row regexes,
`docs/TUI-DESIGN.md` §24 "Engine items". This is precisely a D-M-deferred engine-item text change and must
land in the same commit as its tests.

---

### P2 — `diffRows()`: the one diff renderer, with a gutter, signs, line numbers and roles

**What changes.** A new pure module `src/tui/diff/rows.ts`:

```ts
export type DiffRowKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'more';
export interface DiffRow { kind: DiffRowKind; text: string; oldNo: number | null; newNo: number | null }
export function diffRows(diff: string, opts: { columns: number; maxRows: number; g: GlyphSet; lineNumbers: boolean }): DiffRow[];
```

Row shape at ≥ 60 columns (`lineNumbers: true`):

```
 12    │ def add(a, b):
 13  - │     return a - b
     + │     return a + b        ← new number in the right column when the sides differ
```

At < 60 columns line numbers are dropped and the row is `- <text>`. The `│` separator is `|` under `--ascii`.
`meta` rows (`diff --git`, `index`, `mode`, `similarity`) are **collapsed away** by default and folded into a
single `file` row `calc/ops.py  +12 −3` (letter and rename arrow from P1).

**Where.** new `src/tui/diff/rows.ts`; consumed by `Review.tsx` (P3), `Transcript.tsx` detail rows (P4),
`src/undo/diff.ts` `diffStepLines` (the `/diff <step>` block keeps its git-shaped text and gains the roles
only — see P5's identity note).

**Theme.** `src/tui/theme.ts` gains four roles: `added` (`green`/`greenBright`, marker `+`),
`removed` (`red`/`redBright`, marker `-`), `hunk` (`accent`, marker `@@`), `diffMeta` (`dim`, marker `···`).
`daltonized` swaps `removed` to blue; `ansi` keeps the 16-colour names only; `light` darkens both.
Every role already has its **marker in the text** (the `+`/`-`/`@@` sign), so `NO_COLOR` / `--no-color` /
`TERM=dumb` lose nothing — this is the §14.1 "marker beside every colour" rule satisfied for free.

**Edge cases.** (1) a tab → expanded to the next 4-cell stop **inside the row builder** (never emitted raw),
so no fixed-width box can be broken; (2) trailing whitespace on an `add`/`del` row → rendered as `·` cells in
the `diffMeta` role, only when the row's counterpart differs solely by whitespace (otherwise it is noise);
(3) a BOM at the start of an added line → shown as `<BOM>` in `diffMeta`; (4) other zero-width / bidi
controls → already stripped by `sanitizeStream`, but `​`/`‮` are **not** in `CONTROL_RE`, so the row
builder maps every `Cf` code point to `·`; (5) a line longer than the row → cut with `…` and the row gains a
`(+N chars)` tail in `diffMeta` when there is room; (6) CRLF → already normalised upstream; (7) a lone `\r`
inside a line → `·`; (8) `\ No newline at end of file` → a `meta` row kept verbatim (git's own text);
(9) a hunk header with a section name (`@@ … @@ def add(`) → the section name in `diffMeta` after the range;
(10) a malformed hunk (`@@` without ranges) → `meta`, numbering suspended for that hunk, never thrown;
(11) line numbers past 99 999 → the number column widens, the text column shrinks, never overflows;
(12) `columns < 20` → numbers and separator dropped, sign + one space + text; (13) a diff containing a
line that itself starts with `diff --git` inside a hunk body (a diff of a diff) → the body sign (` `/`+`/`-`)
is consumed first, so it is never mistaken for a header; (14) an empty diff → `[]`;
(15) `maxRows` reached → a final `more` row (see P3 for its text).

**Tests.** unit `test/unit/tui/diff/rows.test.ts` — the fifteen cases, plus: every returned row's
`cellWidth ≤ columns`; no row contains `\t`; the `--ascii` twin of every row differs only in glyphs;
a golden multi-file diff at 40/60/80/120 columns. Unit `theme.test.ts`: the four new roles exist in all four
themes, carry markers, and satisfy the round-3 §2 contrast/256-cube checks.

**Perf gate.** `diffRows` is called at most once per review frame and once per `<Static>` detail item.
Bound: 5 000 input lines → ≤ 2 ms (unit benchmark). It must never run on the composer path
(D-F: keystroke → frame p95 < 16 ms) — `Review` memoises on `(diff, columns, glyphs)`.

**Identity: COLOUR/LAYOUT** for the review card and the `<Static>` detail rows (both are already
outside `formatTranscriptItem`; the §5.3 normaliser is over item rows, and `detail` is TUI-only per
`docs/TUI-DESIGN.md:1597`). **TEXT** only where P5 changes `/diff <step>`'s block lines.

---

### P3 — The review card for a file edit: multi-file summary first, then the change

**What changes.** `reviewCardLines` (`review/lines.ts:143`) gains a preview built by `diffRows` for the three
edit kinds, in this order:

1. when the action touches ≥ 2 files, a **summary block first**, one row per file, capped at 5 rows plus
   `  … +N more files`:
   `  M calc/ops.py   +12 −3` / `  A README.md     +2 −0` / `  R old.py → new.py  +0 −0`;
2. then the hunks of the **first** file, `diffRows` with `lineNumbers` on, meta rows collapsed;
3. the tail row, reworded to tell the truth about what `e` can reach:
   `…[+N rows · e expands to M · /diff 4 shows all]` — where `N` is the rows hidden at this budget, `M` the
   rows `e` would grant, and the `/diff <step>` hint appears only once the step number exists.

`previewWant` (`Review.tsx:79`) becomes `diffRows(...).length` — which for an `edit` drops from `old+new+2`
to the real hunk size, so the layout stops asking for 402 rows for a one-line edit (A6-2 side-effect).

The title (`reviewCardTitle:124`) uses P1's target and closes its quote before truncating
(`"<goal…>"` not `"<goal…`) — fixes A6-22.

**Where.** `src/tui/review/lines.ts:124–161,290–304`; `src/tui/Review.tsx:73–81,135–139,163–187`
(per-row role instead of blanket `dim`); `src/tui/theme.ts` (P2's roles).

**Edge cases.** (1) 200-file patch → the summary block caps at 5 + `… +195 more files`, the hunk block shows
file 1 only, the tail names `/diff`; (2) a 5 000-line patch → `clipDetail`'s 60-line clip is **bypassed** for
the card (the card builds from the `Action` directly, not from the clipped detail), and the tail's `M` is the
true total, fixing A6-11; (3) `write` of a 3 000-line file → treated as `A` with `+3000 −0`, the preview shows
the first `maxRows` lines with `+` signs and no trailing blank row (fixes A6-9 by dropping a single trailing
`''`); (4) `e` with nothing more to show → the key is a no-op today, so `App.tsx:1512` gains a toast
`nothing more to expand — /diff <n> after the step` (fixes A6-10) and never re-renders; (5) rows ≤ 8 → the
existing card ladder (`:139–141`) is unchanged, the preview is simply 0 rows; (6) 12×60 flat tier →
`reviewHeaderLines` path, preview rows come from the same builder at the flat width; (7) binary file →
one row `B assets/logo.png  binary (4.1 KiB → 5.0 KiB)`, never bytes; (8) the file is on the secret denylist
(`isSecretPath`, `sandbox/paths.ts`) → the row shows the path and `content withheld (secret path)`, never a
line of it; (9) a `d` note is open → the note field still replaces row 1 and the preview is untouched
(`:149`); (10) the review is declined/aborted mid-draw → unchanged, the card is pure.

**Tests.** unit `test/unit/tui/review/lines.test.ts` — the ten cases; every row exactly `columns` cells; the
card's total rows ≤ `n` at n ∈ {3…20}; `--ascii` and `sr` twins. Component `test/unit/tui/review.test.tsx` —
the per-row roles (`added`/`removed`/`hunk`) are applied to the right rows with `color=false` producing
identical text. pty `test/pty/smoke/review-patch.steps` (new, needs P8): the card at 24×80 and at 12×60 shows
the summary block, `e` expands, `y` approves, zero clears per geometry segment.

**Perf gate.** The card is drawn inside the review frame, not the composer frame. Gate: the frame that
commits the card must still satisfy the round-1 dynamic-region budget (rows − 2) and add **zero** clears
(`src/perf/states.ts` `review` scenario, extended with the patch variant). D-F unaffected.

**Identity: COLOUR/LAYOUT.** The card is a dynamic-region overlay; it is not a transcript item and appears in
no `transcript.log`. The only text that changes is the **preview tail** and the **card title's target**, and the
title's target is P1's (already classified TEXT there). The tail is card-only. `--plain` twin: the readline
confirmer's `printRequest` (`plain.ts:680–687`) must render the **same** rows through the same builder
(indent 2, no colour) — that is the declared normaliser for this surface and needs the corresponding
`test/unit/tui/plain.test.ts` pin.

---

### P4 — Colour and structure for diff detail rows in `<Static>`

**What changes.** `Transcript.tsx:127–131` stops painting every detail row `dim`. A detail body may declare a
kind on the item: `TranscriptItem.detailKind?: 'diff' | 'table' | 'text'` (optional, default `'text'` —
a default-preserving widening, so no producer must change). When `detailKind === 'diff'` the rows are routed
through `diffRows` and painted with P2's roles; otherwise today's behaviour is kept exactly.
`itemsFromEvent('proposal')` (`plain.ts:321–326`) sets `detailKind: 'diff'` for `edit`/`write`/`patch`;
`block()` sets it for `/diff`.

**Where.** `src/tui/plain.ts` (`TranscriptItem`, `itemsFromEvent`, `localItem`); `src/tui/Transcript.tsx:127–131`;
`src/cli/session.ts:1215` (`block(head, lines, { detailKind })`).

**Edge cases.** (1) round 3's D-L indents detail rows to column 10 — the diff rows must be built at
`columns − 10` (see P5); (2) `--plain`/`--json`/`transcript.log` ignore `detailKind` entirely (detail is
already dropped there); (3) an item whose `detail` is not a diff but starts with `---` → only the declared
kind routes, never a sniff; (4) `NO_COLOR` → signs carry it; (5) `--ascii` → `glyphTwin` already applies to
detail rows (`Transcript.tsx:73`) and the row builder emits ASCII-safe separators; (6) the 20 000-item
`<Static>` soft cap and the epoch remount are untouched (the rows are computed at append time, memoised per
item key, so a remount costs one rebuild per item — bounded by the cap).

**Tests.** component `test/unit/tui/transcript.test.tsx`: a `detailKind: 'diff'` item's rows carry the three
roles and, with `color=false`, are byte-identical to today's rows; a `detailKind: 'text'` item is unchanged
(regression pin). Unit `plain.test.ts`: `detailKind` is set for the three edit kinds and unset for `read`/`run`.

**Perf gate.** `<Static>` rows are committed once. The append path must stay under the static-append budget
(`src/perf/static-append.ts`); gate: appending a 60-row diff detail item adds ≤ 1 frame and no clear.
D-F unaffected (no composer path).

**Identity: COLOUR/LAYOUT.** `formatTranscriptItem` is untouched; `detail` is TUI-only. The §5.3 normaliser
is unaffected (it runs over the item's own rows, not its detail body).

---

### P5 — `/diff` as a real block: width-aware, uncapped when asked, aligned under the gutter

**What changes.**

1. `diffStatBlock(input, columns)` gains `columns` meaning **the body width** (`terminal − gutter`), and
   `session.ts:2332` passes `columns() - LABEL_GUTTER` (round 3's `LABEL_GUTTER = 10`, `Transcript.tsx`) —
   fixes A6-15.
2. `diffStatBlock` stops truncating `lines[0]`: the header is produced **short** — `diff · run <id8> · N files · +a −b`
   (≤ 52 cells) with the zero-valued clauses dropped, and the non-zero ones (`c untracked`, `d binary`,
   `e skipped`) moved to their own `meta` rows at the bottom of the block. Fixes A6-4 and A6-18 and satisfies
   round-3 rule 8 (`[ui]` heads ≤ 60).
3. `block()` gains `maxDetailLines?: number` and `note`/`localItem` honour it instead of the fixed
   `TRANSCRIPT_DETAIL_MAX_LINES = 60`: `/diff` passes `DIFF_ROW_CAP + 8` normally and `Infinity` with `--all`
   (clipped only by `TRANSCRIPT_DETAIL_MAX_CHARS`, raised to 200 000 for `diff` blocks). Fixes A6-5.
4. `diffBar` returns `''` when every row's total is equal (no information), and keeps the bar otherwise.
   Fixes A6-17.
5. `/diff <step>`'s `diffStepLines` keeps its git-shaped text (so `/copy diff` and `--full` stay pasteable)
   but the TUI routes it through `detailKind: 'diff'` (P4) for colour only.
6. `--plain`: `block()`'s else-branch writes the head as one `[ui]` item and the body as **bare lines**
   through a new `Renderer.blockLines(lines)` (default implementation = today's per-line `note`, so no
   renderer breaks), so the columns line up. Fixes A6-16.

**Edge cases.** (1) 0 files → `diff · run <id8> · no changes`; (2) unborn repo → the existing
`EMPTY_TREE_OID` path unchanged; (3) not a git repo → today's `uiError` unchanged; (4) `columns < 30` →
the bar and the padded counts are already dropped (`DIFF_BAR_MIN_COLUMNS`, `DIFF_PADDED_COUNTS_MIN_COLUMNS`),
now measured against the **body** width; (5) 2 000 changed files with `--all` → 2 000 detail rows in one
`<Static>` item: bounded by `TRANSCRIPT_DETAIL_MAX_CHARS` and by the 20 000-item cap, and the block gains a
final `… rendering stopped at N rows (/diff --full)` row when the char bound bites; (6) a path with a `†`
in it → the dirty mark is appended after truncation and `truncateLeftCells` already reserves its cell
(`undo/diff.ts:274`); (7) a submodule (`S`) and a symlink → `S` today; a symlink gets `L` and
`→ <target>` when `lstat` says so (`collectDiffStat` already `lstat`s); (8) a non-UTF-8 file → the `--no-index`
numstat returns `-\t-` → `B`, never bytes; (9) a generated/vendored path → no special-casing, but the row
sorts last when `.gitattributes` marks it `linguist-generated` **only if** the information is free (it is not
today) — **out of scope, left as an open question**; (10) `/diff` while a run is live → already allowed
(`availableDuringTask: 'any'`), the block reflects the tree at that instant and the head gains ` (run live)`.

**Tests.** unit `test/unit/undo/diff.test.ts`: the short header at 40/80/120; no truncation of the head;
the bar suppressed on equal rows; body-width rows; the `--all` bound. Unit `session.test.ts`: `/diff` in
`--plain` emits one `[ui]` head + bare body lines that are byte-identical to the TUI's detail rows.
Component: a `/diff` item under round 3's 10-cell gutter fits at 80 and 120 columns.
pty `test/pty/smoke/diff-block.steps` (new): `/diff` at 24×80 after a mocked run — the head is one row,
`0 skipped)` present or absent by construction (never truncated), rows aligned under column 10, zero clears.

**Perf gate.** `/diff` spawns git; it is an idle/any command, not on the loop's path and not on the composer
path. Gate: the `/diff` keystroke → frame p95 < 16 ms for the *echo* (the block arrives asynchronously),
and the block's append adds ≤ 1 frame and no clear.

**Identity: TEXT** for the `/diff` head and for the `--plain` body shape — but **local `[ui]` items only**
(`plain.ts:496–508` `localItem`; never in `transcript.log`), the same class as round 3's `/cost` head change.
Twins to update: `docs/TUI-DESIGN.md:2159` §24 "Renderer-originated items" (the `[ui] diff (…)` string),
`docs/COMMANDS.md:19`, `test/unit/cli/session.test.ts`, `test/pty/round2.pty.test.ts` regexes that grep
`diff (run`.

---

### P6 — The post-apply row names the files and offers `/diff <n>`

**What changes.** `stepOutcomeText` (`plain.ts:446–449`) becomes, for an outcome with `changedFiles`:

```
edited 3 files: calc/ops.py +12 −3, calc/io.py +4 −1, README.md +2 −0
```

capped at 3 names plus `(+N)`, and the `[step N]` row's outcome segment becomes
`3 files +18 −4` (short) with the full list living in the `outcome` item. The `[step N]` row gains a trailing
` · /diff <N>` hint **only when** the step changed files and the terminal has room (it is the last segment, so
round 3 rule 3's segment wrap drops it first).

Counts come from P1's `editSummary` on the **proposal's** action, which is already in `StepRecord.proposal`
(`core/types.ts:402`) — no new engine field and no extra I/O. When the action is `run` (files changed by a
command) the counts are unavailable and the row keeps `N files`.

**Edge cases.** (1) `run` that changed files → no counts, `3 files`; (2) patch applied but `changedFiles`
disagrees with the header parse (a rename git resolved differently) → prefer `changedFiles` for names,
`editSummary` for counts, and drop the counts when the name sets differ; (3) 200 files → `200 files +9k −3k`;
(4) declined/blocked/failed → unchanged (`declined` / `blocked` / `failed`); (5) a failed patch → P7;
(6) `/diff <N>` hint suppressed when no checkpoint images exist for that step (`readPostImages` would fail) —
the engine already knows (`StepRecord`), so the hint is conditional, never a dead command.

**Tests.** unit `plain.test.ts` for the six cases; `session.test.ts` for the `--plain` twin;
pty: the existing `review-y.steps` gains an `expect` on the new step row.

**Perf gate.** Pure string building on the step-end event; `lag p95 < 5 ms while typing during a run` — the
row is built once per step, memoised per `StepRecord`.

**Identity: TEXT — engine items in `transcript.log`.** This is the D-M-deferred class. Formatter:
`stepSummaryText`/`stepOutcomeText`/`outcomeText` in `src/tui/plain.ts`. `--plain` twin follows
automatically. Pinned tests/docs to update: `test/unit/tui/plain.test.ts`, `test/unit/cli/session.test.ts`,
`src/perf/pty.ts` step-row regex, `test/pty/smoke/{review-y,review-d,chat-task,zero-arg-run}.steps`,
`test/pty/round2.pty.test.ts`, `docs/TUI-DESIGN.md` §24, `docs/TUI-DESIGN-2.md` §4.5.

---

### P7 — A patch that does not apply gets a readable failure card

**What changes.** `PatchError` already carries git's stderr as its second argument
(`workspace/patch.ts:194,197`); today it is dropped. Instead:

* `PatchError` gains a typed `hunks: { file: string; line: number | null; message: string }[]` parsed from
  git's `error: patch failed: <file>:<line>` / `error: <file>: <message>` pairs;
* `engine.ts:2716` puts the first two messages into `outcome.error` and the whole list into the event's
  `detail`;
* the TUI renders it as a `detailKind: 'text'` block under the `[step N]` row:

```
[step 4] patch failed: calc/ops.py:12 — patch does not apply
         calc/ops.py:12   context did not match (the file changed after the proposal was made)
         hint: /diff 3 shows what step 3 wrote to calc/ops.py
```

**Edge cases.** (1) the user edited the file meanwhile → `git apply --check` fails with
`patch does not apply`; the hint names the last step that wrote the same path (the engine has
`StepRecord.outcome.changedFiles`), or says `the file changed outside JevCode` when no step did;
(2) sandbox denial (`sandboxExecDenied`, `core/types.ts:188`) → `sandbox denied git apply (exit 71)` and the
sandbox item, never a patch diagnosis; (3) permission denied → git's `error: … : Permission denied`
surfaces as the message with the path; (4) file vanished → `error: … : No such file or directory`;
(5) path escape / secret path → `PathEscapeError` before git runs (`patch.ts:176–180`), message names the
path only; (6) diff > `MAX_PATCH_BYTES` → `diff exceeds 4194304 bytes` (already); (7) empty diff →
`empty diff` (already); (8) git's stderr locale is already pinned — `GIT_ENV` sets `LC_ALL: 'C'` (`src/workspace/git.ts:32`), so the parse is stable and needs no change; (9) partial apply is impossible (`--check` first, no `--reject`) — the wording must never
suggest a half-applied tree; (10) 200 failing hunks → first 3 rows plus `… +197 more`.

**Tests.** unit `test/unit/workspace/patch.test.ts`: the stderr parser over recorded git outputs for
"does not apply", "already exists", "No such file", "Permission denied", a non-`error:` stderr, and an empty
stderr. Unit `plain.test.ts`: the outcome text and detail. pty: a mock step whose patch cannot apply (P8).

**Perf gate.** None on the frame path; the parse runs once per failure.

**Identity: TEXT** (engine item `outcome failed: …`). Same twin list as P6 plus
`docs/TUI-DESIGN.md` §24.

---

### P8 — Make the patch path reachable in `--mock`, and pin it

**What changes.** `mockTrajectory` (`cli/mock-trajectory.ts:33–47`) gains a fifth turn kind, a `patch` that
edits two files at once, and a sixth that is deliberately unappliable, both **off by default** behind
`JEVCODE_MOCK_PATCH=1` (so every existing pty smoke and perf number is byte-unchanged). `docs/TUI.md` and
`src/perf/states.ts` list the new `review-patch` state.

**Edge cases.** (1) the default trajectory must stay identical — asserted by a unit test that
`mockTrajectory(40)` with the env unset equals a golden array; (2) the patch must apply inside
`examples/demo-py` and in the scratch files the trajectory itself created, so no external fixture is needed;
(3) the unappliable patch must fail at `--check`, leaving the tree clean (asserted by `git status` after the run).

**Tests.** pty `test/pty/smoke/review-patch.steps` (24×80 and 12×60) and `test/pty/smoke/patch-failed.steps`;
`src/perf/states.ts` gains the `review-patch` scenario with the same zero-clears and budget gates as `review`.

**Perf gate.** The new scenarios must meet the existing gates: zero clears per geometry segment, painted
dynamic rows ≤ rows − 2, first frame < 300 ms (the trajectory is built after the first frame, so unchanged).

**Identity: none** (test fixtures only).

---

### P9 — Screen-reader and `--plain` twins of the change

**What changes.** `reviewScreenReaderLines` (`review/lines.ts:278–288`) gains, between the aria rows and the
choices, a spoken summary and a bounded spoken diff:

```
change: 3 files, 18 lines added, 4 removed
file 1 of 3, calc slash ops dot py, modified, 12 added, 3 removed
line 13 removed: return a minus b
line 13 added: return a plus b
… 14 more changed lines; press 3 then diff for the full text
```

Signs are spoken as words (`removed:` / `added:`), paths are spoken with `slash` / `dot` separators, and the
row count is bounded by `SR_DIFF_ROWS = 12` with the tail sentence. The readline confirmer's `printRequest`
(`plain.ts:680–687`) renders the **same** `diffRows` output (indent 2, signs, no colour, no line-number
column below 60 columns) and replaces `…[N preview lines omitted]` with the same truthful tail as P3.

**Edge cases.** (1) `--screen-reader` plus `--ascii` → ASCII separators; (2) a binary file → `binary file,
4.1 kibibytes before, 5.0 kibibytes after`; (3) a 200-file patch → the summary sentence plus file 1 only;
(4) a whitespace-only change → `line 13 changed: trailing whitespace removed` rather than two identical
spoken lines; (5) no preview (a `read`/`run` proposal) → today's output byte-for-byte.

**Tests.** unit `review/lines.test.ts` (`sr` glyph set) for the five cases; `plain.test.ts` for the readline
twin; a pinned assertion that with `GLYPHS.sr` no bar and no box glyph appears.

**Perf gate.** SR mode already forces reduced motion and the flat tier; the extra rows must still fit the
`reviewHeaderLines` ladder (the SR path is `<Static>`, not the dynamic region, so no budget change).

**Identity: COLOUR/LAYOUT for the readline twin** (the confirmer's preview is not a transcript item) and
**declared normaliser** for SR (SR rows are already a declared twin at `docs/TUI-DESIGN.md` §6.5). The SR
sentences are new strings and need `docs/TUI-DESIGN.md` §24 rows.

---

## 5. Ordering and risk

P2 (rows + roles) and P1 (summary) are the substrate; P3, P4, P5 consume them and are independent of each
other. P6 and P7 are the two engine-item **text** changes and must land together with the twelve pinned test
files D-M enumerated; they are the only proposals here that touch `transcript.log`. P8 must land **before**
P3/P7 so both land against a failing pty test. P9 last.

The single largest risk is P6's text change colliding with round 3's in-flight `[step N]` work (the row is
already being re-wrapped by D-L rule 3); P6 changes only the **outcome segment** of that row, so the two
compose, but they must not be in flight in the same week.

