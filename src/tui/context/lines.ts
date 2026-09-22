/**
 * TUI-DESIGN-5 §3 (D-AG, D-AH, D-AJ): the context meter's render path — the `ctx` status cell, `/context`'s block and
 * `/compact`'s four answers. Pure, Ink-free, zero I/O: every number arrives as an argument, so the one row builder
 * serves the Ink frame, `--plain` and `transcript.log` through `renderBlock` (§13.1 row S45–S59).
 *
 * The four numeric strings are the HARNESS's own (`src/loop/context/meter.ts` — `formatMeter`, `formatBudget`,
 * `formatRecentSteps`, `formatMemory`): this module never re-spells them, it only substitutes the glyph set's
 * separators (§15.1 Q15 — the three formatters stay plain and the TUI post-processes). The moment §8.2 R4 lands an
 * optional `g: GlyphSet` on those functions, `fold()` below is deleted and nothing else changes.
 *
 * **Glyph rule, no exceptions (§13.4).** EVERY sentence this module emits leaves it through `fold()`, the empty
 * states and `/compact`'s answers included, so an `--ascii` caller never has to know which rows were pre-folded and
 * which were not. The exported constants stay in their unicode spelling (that is what the pin tests grep for) and
 * every producer folds them at the point of use.
 *
 * **Units, stated once (§14.2 review finding 2).** `ctxText`, `contextBlock` and `compactionRule` all take
 * **terminal columns**, never a block width: `CONTEXT_MIN_COLUMNS = 80` is the width of the TERMINAL, which is what
 * §3.7's table means by its 40/80/120 headings. `contextBlock` derives the body width it budgets columns against
 * with `blockWidth(columns)` itself. A caller that passes `bodyWidth()` (= `blockWidth(columns())`) would silently
 * drop the per-file table on every terminal 80–89 columns wide.
 *
 * What is NOT here, deliberately: `/context drop <file>` and `/keep <text>` (D-AH N2 — both are engine writes with no
 * `Engine` member), and the compaction notice's text (D-AJ (b) — `src/loop/engine.ts` emits ONE line into all three
 * sinks and round 5 changes none of it; this module contributes only the optional `─ compaction ─` rule above it).
 */
import { blockWidth, elideLeft, type BlockRow } from '../block/lines.js';
import { cellWidth, GLYPHS, type GlyphSet } from '../glyphs.js';
import { METER_AMBER_PCT, METER_RED_PCT } from '../../core/limits.js';
import { formatBudget, formatMemory, formatMeter, formatRecentSteps, meterLevel, type MeterLevel } from '../../loop/context/meter.js';
import { OUTPUT_EVICTED, outputReadPath, outputRefFor, pointerLost } from '../../loop/context/history.js';
import type { ContextSummary } from '../../loop/context/types.js';
import type { ContextUsage, EngineMode, FileCacheEntry, FileMemory, FilePin, HistoryEntry } from '../../core/types.js';

// ---------------------------------------------------------------------------------------
// §3.1 — the `ctx` status cell, two rungs (D-AG as amended by §0.2 / §14.2 #38)
// ---------------------------------------------------------------------------------------

/**
 * §3.1 / §3.7: the SHORT rung, in TERMINAL columns. `ctx 41%` is 7 cells and fits beside `run $0.12/2.00` at 80
 * columns, which is the most common width — a single 100-column gate left requirement 3's "visible usage" absent
 * exactly where it matters.
 */
export const CONTEXT_MIN_COLUMNS = 80;
/** §3.1: the FULL rung, in TERMINAL columns — `formatMeter`'s whole `ctx 41% · 6 files · 12 steps` (28 cells). */
export const CONTEXT_FULL_COLUMNS = 100;

/**
 * §3.1 / §7 row 40: the ONE place a harness-formatted meter string meets the glyph set. `GLYPHS.unicode.dot` is `·`
 * and `.dash` is `—`, so this is the identity for the unicode and screen-reader sets and a substitution for `--ascii`
 * — the same idiom `modeBadgeWord` uses (`src/tui/status/lines.ts:113–114`).
 */
function fold(text: string, g: GlyphSet): string {
  return text.replaceAll(' · ', ` ${g.dot} `).replaceAll('—', g.dash);
}

/** §3.1: the level word beside the colour — `NO_COLOR`, `--ascii` and a screen reader all read this, never a hue. */
export const CONTEXT_LEVEL_WORD: Readonly<Record<MeterLevel, string | null>> = { ok: null, amber: 'amber', red: 'red' };

/** §3.1 / §12 S46: the action that replaces the counts once the cell turns — it lives IN the cell because the notice scrolls away. */
export const CONTEXT_ACTION = '/compact now';

/**
 * §12 S45 / S46 — the `ctx` cell's text at `columns` (TERMINAL columns), or `''` below `CONTEXT_MIN_COLUMNS` (absent
 * is absent: no placeholder, no `ctx —%`, §7 row 35).
 *
 * Three forms, in priority order:
 *   amber/red at either rung  `ctx 87% amber · /compact now`  — it REPLACES the counts, it does not append (§14.2 #57)
 *   ≥ CONTEXT_FULL_COLUMNS    `ctx 41% · 6 files · 12 steps`  — `formatMeter` verbatim, glyph-substituted
 *   ≥ CONTEXT_MIN_COLUMNS     `ctx 41%`                       — built from `u.pct` DIRECTLY, never by truncating the long form
 */
export function ctxText(u: ContextUsage, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (cols < CONTEXT_MIN_COLUMNS) return '';
  const word = CONTEXT_LEVEL_WORD[meterLevel(u.pct)];
  if (word !== null) return `ctx ${u.pct}% ${word} ${g.dot} ${CONTEXT_ACTION}`;
  if (cols < CONTEXT_FULL_COLUMNS) return `ctx ${u.pct}%`;
  return fold(formatMeter(u), g);
}

// ---------------------------------------------------------------------------------------
// §3.1 / §7 rows 41 and 98 — the crossing notice, once per threshold PER PROCESS
// ---------------------------------------------------------------------------------------

/** §3.1: the two thresholds, from the harness's own constants so the word and the number can never disagree. */
export type ContextPct = typeof METER_AMBER_PCT | typeof METER_RED_PCT;
export const CONTEXT_THRESHOLDS: readonly ContextPct[] = [METER_AMBER_PCT, METER_RED_PCT];

/** Every threshold at or below `pct`, ascending. */
export function crossedContextThresholds(pct: number): ContextPct[] {
  if (!Number.isFinite(pct)) return [];
  return CONTEXT_THRESHOLDS.filter((t) => pct >= t);
}

export interface ContextThresholdStep {
  /** the threshold to announce now (the highest newly crossed one), or null */
  warn: { pct: ContextPct; text: string } | null;
  /** the announced set after this tick: every crossed threshold, so a lower one is never announced later */
  announced: ReadonlySet<ContextPct>;
}

/** §12 S47 — the one-time crossing notice, written through `engine.annotate()` so it reaches `transcript.log` too. */
export function contextWarnLine(pct: ContextPct, g: GlyphSet = GLYPHS.unicode): string {
  return fold(`context at ${pct} % of the budget (${CONTEXT_LEVEL_WORD[meterLevel(pct)] ?? 'ok'}) — /compact folds the history now`, g);
}

/**
 * §3.1 / §7 row 41: on every `status` tick — and on `context:warn` when the harness emits one (§15.1 Q16) — the
 * controller calls this with its per-process set. Whichever arrives first announces; the second is a no-op because
 * the set already carries the threshold, so one crossing can never produce two notices.
 *
 * **HIGHEST WINS, and that is the whole contract (§14.2 review finding 4).** This is `nextBudgetWarn`'s shape
 * verbatim (`src/tui/budget/lines.ts:114–123`, "the highest only when one add crosses two"): a single tick that
 * jumps from 40 % to 97 % announces **red once** and arms amber silently, because two notices for one jump are
 * noise and the amber sentence would be stale the moment it was written. The invariant is therefore *at most once
 * per threshold per process, and the highest crossed threshold is always the one announced* — **not** "exactly once
 * per threshold", which no highest-wins rule can satisfy. §10's wording is corrected in this slot's report.
 *
 * §7 row 98: the set is per PROCESS and is never seeded from the checkpoint. `ContextUsage.compactions` counts "over
 * the run's life, all resumes" (`src/core/types.ts`), so a persisted set would mean a user who resumes at 90 % is
 * never told. Re-announcing on a resume is the useful behaviour, and it falls out of starting from an empty set.
 */
export function nextContextWarn(pct: number, announced: ReadonlySet<ContextPct>, g: GlyphSet = GLYPHS.unicode): ContextThresholdStep {
  const fresh = crossedContextThresholds(pct).filter((t) => !announced.has(t));
  if (fresh.length === 0) return { warn: null, announced };
  const next = new Set<ContextPct>(announced);
  for (const t of fresh) next.add(t);
  const hit = fresh[fresh.length - 1]!;
  return { warn: { pct: hit, text: contextWarnLine(hit, g) }, announced: next };
}

// ---------------------------------------------------------------------------------------
// §3.2 — `/context`, one block from three reads (D-AH)
// ---------------------------------------------------------------------------------------

/** §12 S54 — no run is live. */
export const CONTEXT_NO_RUN = "no run is live — /context reports the run's prompt budget";
/** §12 S56 — a live run that has not built a prompt yet. */
export const CONTEXT_NO_PROMPT = 'no prompt built yet — /context fills in at the first step';

/**
 * §12 S58 (which SUPERSEDES the stale S55 cell, §14.2 #4) — a mode that builds no relaxed context. The sentence names
 * the ESCAPE rather than restating the emptiness, because `DEFAULT_MODE` is `'llm-jev'` and `src/loop/engine.ts`'s
 * `contextEnabled` excludes it, so this is the state a fresh install lands in until §8.2 R13 ships.
 */
export function contextNoRelaxed(mode: EngineMode, g: GlyphSet = GLYPHS.unicode): string {
  return fold(`this run does not build a relaxed context (${mode}) — /mode jev-on builds one`, g);
}

/** §12 S53 — the section head; the count comes from `ContextUsage.files`, never from the cache array's length. */
export function filesInViewText(files: number, g: GlyphSet = GLYPHS.unicode): string {
  return `files in view ${g.dot} ${Math.max(0, Math.floor(files))}`;
}

/**
 * §12 S53's reason column, from `FileCacheEntry.pinnedBy` when `fileMemory` has nothing to say. `read`/`edit` are
 * implied by the memory clauses **only when the matching half of the entry is actually set** — see `fileReason`.
 */
export const FILE_PIN_WORD: Readonly<Record<FilePin, string>> = {
  read: 'read',
  edit: 'edited',
  human: 'pinned by you',
  jev: 'pinned by jev',
  seed: 'pinned at the start',
};

/**
 * §7 row 43's sibling: the recoverable-output pointer, listed once and NEVER for an entry whose pointer is lost.
 *
 * **The pointer is resolvable (§14.2 review finding 9).** CO §8.5's rule is that every clip carries a recovery
 * pointer, and an earlier form printed the literal template `jevcode:outputs/step-<n>.txt`, which
 * `parseOutputRef` (`src/loop/context/history.ts:46–53`) rejects — pasting it into `read` failed. The row now names
 * the steps and prints the FIRST of them as a real path, with `(one file per step)` telling the reader how to reach
 * the others. One row, not one per step: a 12-entry history would otherwise swamp the block.
 */
export function outputsOnDiskText(steps: readonly number[], g: GlyphSet = GLYPHS.unicode): string {
  const first = steps[0];
  const word = steps.length === 1 ? 'step' : 'steps';
  const pointer = first === undefined ? '' : ` — read ${outputReadPath(outputRefFor(first))}`;
  const tail = steps.length > 1 ? ' (one file per step)' : '';
  return fold(`full output on disk ${g.dot} ${word} ${steps.join(', ')}${pointer}${tail}`, g);
}

/**
 * §7 row 43's sibling: `HistoryEntry.outputEvicted` — the per-run 64 MiB bound deleted the file, so the pointer
 * "must not be printed again". The sentence is the harness's own `OUTPUT_EVICTED`, never a second spelling of it.
 */
export function outputsEvictedText(n: number, g: GlyphSet = GLYPHS.unicode): string {
  return fold(`${n} step${n === 1 ? '' : 's'}: ${OUTPUT_EVICTED}`, g);
}

/** §3.4 / §3.7: the optional separator the TUI may draw ABOVE the engine's own compaction notice — never instead of it. */
export const COMPACTION_RULE_CAPTION = 'compaction';
/** §3.7: not drawn below 80 TERMINAL columns. */
export const COMPACTION_RULE_MIN_COLUMNS = 80;

/**
 * §3.4 (D-AJ, CO §8.6 "the TUI may decorate… but never replace"): the rule row, or nothing at all. `columns` is the
 * TERMINAL width, the same unit `contextBlock` and `ctxText` take.
 */
export function compactionRule(columns: number): BlockRow[] {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  return cols < COMPACTION_RULE_MIN_COLUMNS ? [] : [{ kind: 'rule', caption: COMPACTION_RULE_CAPTION }];
}

/**
 * §3.4: the engine's own notice with this module's decoration above it — the ONE composition D-AJ allows, offered
 * here as a function so the controller that owns the `context:compacted` notice never has to spell the shape.
 * `notice` is `src/loop/engine.ts:3567`'s text, passed through untouched (round 5 changes none of it).
 */
export function compactionNoticeRows(notice: string, columns: number): BlockRow[] {
  return [...compactionRule(columns), { kind: 'note', flush: true, text: notice }];
}

/** The `41k` form `meter.ts` uses for every char count, so `/context`'s own rows read like the harness's. */
function k(n: number): string {
  const v = Math.max(0, Math.round(n));
  return v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`;
}

/**
 * `2026-09-22T14:02:09.123Z` → `14:02`, in **UTC** — every other timestamp helper on the tree formats UTC
 * (`src/core/log.ts:146`, `src/checkpoint/run-id.ts:57`, `src/bench/runner.ts:51`), §12 S52's pinned
 * `last 14:02` is the UTC reading of its own ISO instant, and a local-time row would make one run dir's
 * `transcript.log` read differently on two machines (§14.2 review finding 8). The raw string comes back when it is
 * not a time we can read (never a throw, never `Invalid Date`).
 */
function hhmm(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * §3.2 read 3's payload, bounded: the rolling summary is why a user opens `/context`, and reading the file without
 * ever showing its text made the third read a date lookup (§14.2 review finding 13). The clip is **declared and
 * asserted**, never silent — the §13.2 clause this needs as a doc row is a request in R5-3's report.
 */
export const SUMMARY_EXCERPT_MAX = 120;

/** `summary · <one line of the rolling summary>` — null when there is no text to show. */
export function summaryExcerptText(text: string, g: GlyphSet = GLYPHS.unicode): string | null {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  if (one.length <= SUMMARY_EXCERPT_MAX) return fold(`summary ${g.dot} ${one}`, g);
  const cut = one.slice(0, SUMMARY_EXCERPT_MAX).replace(/\s+\S*$/, '');
  const head = cut.length > 0 ? cut : one.slice(0, SUMMARY_EXCERPT_MAX);
  return fold(`summary ${g.dot} ${head}${g.ellipsis} (+${one.length - head.length} chars in context/summary.json)`, g);
}

/**
 * The three reads D-AH (c) joins, as data. Every member is optional: `/context` renders whatever arrived and says so
 * when nothing did — it never waits, and it never asks the engine for something it does not already expose.
 */
export interface ContextBlockInput {
  /** read 1: `engine.status().context` — absent when the mode builds no relaxed context */
  usage?: ContextUsage | null | undefined;
  /** `engine.status().step`; omitted from the head when null */
  step?: number | null;
  /** the run's mode, for S58's sentence */
  mode: EngineMode;
  /** false when no run is live at all (S54) */
  live: boolean;
  /** `ResolvedConfig.context?().view`; the head's third word. `status.context` only exists under `relaxed` today */
  view?: 'relaxed' | 'legacy';
  /** read 2: `engine.snapshotState()` — synchronous, in-memory, already used for the last-resort checkpoint write */
  files?: readonly FileCacheEntry[] | undefined;
  fileMemory?: FileMemory | undefined;
  /** read 2, third field: `CheckpointState.history` — the source of §7 row 43's two pointer rows */
  history?: readonly HistoryEntry[] | undefined;
  /** read 3: `CheckpointStore.readContextSummary()` — §7 row 39, read directly rather than waiting for the engine's lazy re-read */
  summary?: ContextSummary | null | undefined;
  /** `formatBudget`'s money arm needs both or neither */
  limits?: { maxSteps?: number; spendCapUsd?: number } | undefined;
}

export interface ContextBlock {
  /** the item's headline — S48, or the plain noun when the block is an empty state */
  head: string;
  rows: BlockRow[];
}

/** §12 S48 — `context · step 12 · relaxed · code compaction`. */
export function contextHead(i: Pick<ContextBlockInput, 'usage' | 'step' | 'view'>, g: GlyphSet = GLYPHS.unicode): string {
  const parts = ['context'];
  if (i.step !== null && i.step !== undefined && Number.isFinite(i.step)) parts.push(`step ${Math.floor(i.step)}`);
  parts.push(i.view ?? 'relaxed');
  if (i.usage) parts.push(`${i.usage.compaction} compaction`);
  return parts.join(` ${g.dot} `);
}

/** §3.7: the per-file table never squeezes the path below this, however long the reason column is. */
export const FILE_PATH_MIN_CELLS = 16;
/** `renderBlock`'s table pass puts two cells between columns; three columns therefore cost four. */
const TABLE_GAPS = 4;

/**
 * §3.7 / §3.1.5 — the per-file rows, with the path cell budgeted BEFORE `layoutTable` sees it.
 *
 * `layoutTable` (`src/tui/block/lines.ts:324–338`) gives every column its natural width and then shrinks **from the
 * right**, so a 61-cell path used to keep all 61 cells and cut the reason column to one (§14.2 review finding 1).
 * §3.7's 80-column cell is explicit that the REASON survives and the path shortens, and §3.1.5 is explicit that a
 * path elides LEFT (the basename is the informative end). So the path is left-elided here to whatever the reason
 * column leaves, never below `FILE_PATH_MIN_CELLS`, and the table then fits without any shrink pass at all.
 *
 * `shortPath()` (§3.7's wording, `src/core/text.ts:71`) is **not** the tool: `FileCacheEntry.rel` is already
 * workspace-relative and `shortPath` returns a relative path unchanged (`:73`). `elideLeft` is the primitive that
 * sentence describes.
 */
function fileRows(cache: readonly FileCacheEntry[], memory: FileMemory | undefined, width: number, g: GlyphSet): BlockRow[] {
  if (cache.length === 0) return [];
  const cells = cache.map((f) => ({ rel: f.rel, bytes: k(f.bytesShown), reason: fileReason(f, memory, g) }));
  const bytesCol = Math.max(1, ...cells.map((c) => cellWidth(c.bytes)));
  const reasonCol = Math.max(1, ...cells.map((c) => cellWidth(c.reason)));
  const natural = Math.max(1, ...cells.map((c) => cellWidth(c.rel)));
  const room = Math.max(1, width - TABLE_GAPS - bytesCol);
  const pathCol = Math.max(1, Math.min(natural, Math.max(FILE_PATH_MIN_CELLS, room - reasonCol)));
  return cells.map((c) => ({ kind: 'table', cells: [elideLeft(c.rel, pathCol, g), c.bytes, c.reason] }));
}

/**
 * §3.2 — `/context`'s one block. The three empty states are DISTINCT sentences (§7 rows 35–37): a block with a single
 * `note` row, the §3.1.7 shape `/cost` already uses, never a data row promoted to the head.
 *
 * `columns` is the **terminal** width (see the module docblock): below `CONTEXT_MIN_COLUMNS` the file section is the
 * count row alone; at or above it the per-file table carries the reason column, budgeted against
 * `blockWidth(columns)` — the width `renderBlock` will be handed.
 */
export function contextBlock(i: ContextBlockInput, columns: number, g: GlyphSet = GLYPHS.unicode): ContextBlock {
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (!i.live) return { head: 'context', rows: [{ kind: 'note', flush: true, text: fold(CONTEXT_NO_RUN, g) }] };
  const u = i.usage;
  if (u === null || u === undefined) return { head: 'context', rows: [{ kind: 'note', flush: true, text: contextNoRelaxed(i.mode, g) }] };
  if (u.promptChars <= 0 && u.summaryAt === null && (i.summary === null || i.summary === undefined)) {
    return { head: contextHead(i, g), rows: [{ kind: 'note', flush: true, text: fold(CONTEXT_NO_PROMPT, g) }] };
  }

  const rows: BlockRow[] = [];
  // S49 — every arm is `formatBudget`'s; the design's earlier `budget 70k of 128k window (55 %)` was a string the
  // function never returns, so it is the as-built output that is pinned here (§14.2 #37).
  rows.push({ kind: 'note', flush: true, text: fold(formatBudget(u, i.limits ?? {}), g) });
  // S50
  rows.push({ kind: 'note', flush: true, text: fold(formatRecentSteps(u), g) });
  // §0.3 item 2 (contract 1.6): the memory row, null on a run that never imported anything
  const memory = formatMemory(u);
  if (memory !== null) rows.push({ kind: 'note', flush: true, text: fold(memory, g) });
  // S51
  // §12 S51 is `prompt build 41 ms · file refresh 6 ms` — WHOLE milliseconds. The engine measures with
  // `performance.now()`, so the raw values are fractional and of differing precision (`826.1` beside `825.65`
  // in a real capture), which reads as noise in a row whose job is an order of magnitude. Rounded HERE rather
  // than at the meter: the meter's number is the measurement and other readers may want it whole.
  rows.push({ kind: 'note', flush: true, text: `prompt build ${msWhole(u.promptBuildMs)} ms ${g.dot} file refresh ${msWhole(u.refreshMs)} ms` });
  // S52 — read 3 answers `summaryAt` on a resume whose engine has not lazily re-read the file yet (§7 row 39)
  const summaryAt = u.summaryAt ?? i.summary?.step ?? null;
  if (summaryAt !== null) {
    const at = u.lastCompactionAt ?? i.summary?.at ?? null;
    const parts = [`summary at step ${summaryAt}`, `${u.compactions} compaction${u.compactions === 1 ? '' : 's'}`];
    if (at !== null) parts.push(`last ${hhmm(at)}`);
    rows.push({ kind: 'note', flush: true, text: parts.join(` ${g.dot} `) });
  }
  // read 3's own payload — the text the summary row above only dates
  const excerpt = i.summary ? summaryExcerptText(i.summary.text, g) : null;
  if (excerpt !== null) rows.push({ kind: 'note', flush: true, text: excerpt });

  // §7 row 43's sibling: the pointers, and the evicted count that must NOT carry one
  const history = i.history ?? [];
  const onDisk = history.filter((e) => e.outputRef !== undefined && !pointerLost(e, false)).map((e) => e.step);
  const evicted = history.filter((e) => e.outputEvicted === true).length;
  if (onDisk.length > 0) rows.push({ kind: 'note', flush: true, text: outputsOnDiskText(onDisk, g) });
  if (evicted > 0) rows.push({ kind: 'note', flush: true, text: outputsEvictedText(evicted, g) });

  // S53 — the count, then the per-file table at or above the short rung
  rows.push({ kind: 'gap' });
  rows.push({ kind: 'note', flush: true, text: filesInViewText(u.files, g) });
  if (cols >= CONTEXT_MIN_COLUMNS) rows.push(...fileRows(i.files ?? [], i.fileMemory, blockWidth(cols), g));
  return { head: contextHead(i, g), rows };
}

/** §12 S51: whole milliseconds, total over a non-finite or negative measurement (both read as `0 ms`). */
function msWhole(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

/**
 * §12 S53's third cell — `read at step 4 · edited step 6 · pinned by you`, joined from the two state fields.
 *
 * The pin word is appended whenever the memory clauses do NOT already imply it (§14.2 review finding 10): an entry
 * with `editedAt: null` and `pinnedBy: 'edit'` used to read `read at step 4`, hiding the edit that is the actual
 * reason the file is in view.
 */
export function fileReason(f: FileCacheEntry, memory: FileMemory | undefined, g: GlyphSet = GLYPHS.unicode): string {
  const m = memory?.[f.rel];
  const readAt = m?.readAt ?? null;
  const editedAt = m?.editedAt ?? null;
  const clauses: string[] = [];
  if (readAt !== null) clauses.push(`read at step ${readAt}`);
  if (editedAt !== null) clauses.push(`edited step ${editedAt}`);
  const implied = (f.pinnedBy === 'read' && readAt !== null) || (f.pinnedBy === 'edit' && editedAt !== null);
  if (!implied) clauses.push(FILE_PIN_WORD[f.pinnedBy]);
  return clauses.join(` ${g.dot} `);
}

// ---------------------------------------------------------------------------------------
// §3.3 — `/compact`'s four answers
// ---------------------------------------------------------------------------------------

/** §12 S57 — the count did not rise and compaction is ON: there really is only one step in history. */
export const NOTHING_TO_COMPACT = 'nothing to compact — only the newest step is in history';

/**
 * §12 S58a — the fourth branch, checked BEFORE S57 (§14.2 #15). `src/loop/engine.ts`'s `compact()` body is
 * `if (!this.contextEnabled || this.isFinished() || this.contextPolicy.compaction === 'off') return;`, so with
 * `compaction: 'off'` it returns immediately with no status emit and no change to `compactions` — a two-row table
 * falls through to S57 and tells the user "only the newest step is in history", which may be a falsehood over forty
 * foldable steps. The state is observable without a contract change: `ContextUsage.compaction` is already on
 * `status().context`, and `context.compaction` is the setting §3.6 itself introduces.
 */
export const COMPACTION_OFF = 'compaction is off for this run (context.compaction) — jevcode config set context.compaction code turns it on';

/**
 * The fifth state, which the design's four-row table does not name (§14.2 review finding 11): the run had a context
 * before the call and has none after it. `Engine.compact()`'s `this.isFinished()` guard (`src/loop/engine.ts:1520`)
 * returns with no emit exactly like the `off` case, so this is reachable — and answering S57 for it would be a
 * falsehood of precisely the kind §3.3's fourth row was added to stop. The second clause is `availabilityError`'s
 * own `'live'` sentence (`src/tui/commands/registry.ts:764`), so the user reads one vocabulary, not two.
 */
export const COMPACT_RUN_ENDED = 'the run is no longer live — /compact needs a live run';

/**
 * §3.3 — what `/compact` says. `Engine.compact()` returns `void` and emits its status synchronously, so the answer is
 * a before/after comparison of `status().context` across the call.
 *
 * `null` means SAY NOTHING: the count rose and the engine's own notice line (§3.4, S59) already reported what
 * happened, in all three sinks. A second sentence here would be the duplicate D-AJ exists to prevent.
 */
export function compactAnswer(
  before: ContextUsage | null | undefined,
  after: ContextUsage | null | undefined,
  mode: EngineMode,
  g: GlyphSet = GLYPHS.unicode,
): string | null {
  const b = before ?? after;
  if (b === null || b === undefined) return contextNoRelaxed(mode, g);
  if (b.compaction === 'off') return fold(COMPACTION_OFF, g);
  if (after === null || after === undefined) return fold(COMPACT_RUN_ENDED, g);
  if (after.compactions > b.compactions) return null;
  return fold(NOTHING_TO_COMPACT, g);
}
