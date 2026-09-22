/**
 * Every import string, once (TUI-DESIGN-5 §5.2, §5.3, §12.4 S89–S98, §13.1, §13.4; IMPORT-DESIGN §5.2).
 *
 * Two rules, both from §13.1:
 *
 *  1. **The eighteen `[import]` item texts live in `src/config/imports.ts` and are only RE-EXPORTED here** — the
 *     same split `src/tui/onboarding/lines.ts` already uses for `keyEnteredText` / `savedText`
 *     (`src/config/credentials.ts:36,45`). Re-declaring one here is the drift TD4 D-V's pin inventory exists to
 *     prevent; `test/unit/tui/import/lines.test.ts` asserts every builder in `IMPORT_ITEM_BUILDERS` is re-exported
 *     and that this file contains no second `[import]` literal.
 *  2. **The overlay is `BlockRow[]` through `renderBlock` / `blockWidth`** (D-AO), not a bespoke renderer, and its
 *     width behaviour is round 4's: `fitRung` picks the head and the keys row, `blockWidth(columns)` bounds the body.
 *
 * Pure, Ink-free, and — gate G-R5-1 — no value import of `src/import/**`.
 */
import { blockTier, blockWidth, oneLine, renderBlock, type BlockRow, type RenderedRow } from '../block/lines.js';
import { fitRungIn } from '../fit.js';
import { GLYPHS, glyphTwin, padEndCells, padStartCells, cellWidth, type GlyphSet } from '../glyphs.js';
import { CAP } from '../layout.js';
import { IMPORT_GLYPHS, IMPORT_GLYPHS_ASCII, importCount, importInterruptedItem, importSize, type ImportGlyphs } from '../../config/imports.js';
import type { PlanGroupKey } from '../../import/index.js';
import type { ImportPlan } from '../../core/types.js';
import { reviewRowsOf, rowsOfGroup, type ImportGroupRow, type ImportUiInput, type ImportUiState } from './reducer.js';

// ---------------------------------------------------------------------------------------
// §13.1: every `[import]` item (`IMPORT_ITEM_BUILDERS`, 18) — RE-EXPORTED, never re-declared
// ---------------------------------------------------------------------------------------

export {
  IMPORT_ITEM_BUILDERS,
  IMPORT_LABEL,
  importActiveItem,
  importAppliedItem,
  importCancelledItem,
  importCredentialItem,
  importCredentialsFoundItem,
  importInterruptedItem,
  importJevItem,
  importNothingFoundItem,
  importPlanItem,
  importReportItem,
  importRetentionItem,
  importSkippedRowItem,
  importSkippedSourceItem,
  importSourceChangedItem,
  importTrustChangedItem,
  importTrustRepinnedItem,
  importUndoItem,
  importWriteErrorItem,
  importCount,
  importSize,
  importUsd,
  shortImportId,
} from '../../config/imports.js';

/** The glyph subset the `config/imports.ts` builders take, derived from the TUI's real `GlyphSet`. */
export function importGlyphs(g: GlyphSet): ImportGlyphs {
  return g.mode === 'ascii' ? IMPORT_GLYPHS_ASCII : IMPORT_GLYPHS;
}

// ---------------------------------------------------------------------------------------
// §12.4 S89 — the overlay head, as a rung ladder (§5.8: 40 / 80 / 120)
// ---------------------------------------------------------------------------------------

/**
 * §12.4 S89 verbatim at the widest rung; §5.8's three widths are the three rungs (40 drops the words, 80 drops the
 * byte total, 120 is S89 whole). Every rung is measured AFTER glyph substitution, so the `--ascii` twin picks its
 * own rung rather than being truncated (§2.6 edge 2).
 */
export function importHeadRungs(toImport: number, toReview: number, skipped: number, bytes: number): readonly string[] {
  const k = importCount(skipped);
  return [
    `Import {dash} ${toImport} to import {dot} ${toReview} to review {dot} ${k} skipped {dot} ${importSize(bytes)}`,
    `Import {dash} ${toImport} to import {dot} ${toReview} to review {dot} ${k} skipped`,
    `Import {dash} ${toImport} {dot} ${toReview} {dot} ${k}`,
  ];
}

/** §12.4 S89: the widest head that fits `width` cells. */
export function importHead(toImport: number, toReview: number, skipped: number, bytes: number, width: number, g: GlyphSet = GLYPHS.unicode): string {
  return fitRungIn(importHeadRungs(toImport, toReview, skipped, bytes), width, g, { dash: g.dash, dot: g.dot });
}

// ---------------------------------------------------------------------------------------
// §12.4 S90 — the group rows
// ---------------------------------------------------------------------------------------

/** §5.2 / F-56: the fixed hint each group row carries when it has no source list of its own. */
export const GROUP_NOTE: Readonly<Record<PlanGroupKey, string>> = {
  memory: '',
  rules: '',
  commands: '',
  mcp: 'disabled on import',
  config: 'suggested, not applied',
  review: '',
  skipped: '',
};

/** §5.2 F-56: `review 9   3 conflicts · 4 secrets · 2 ambiguous` — counted from the plan, never guessed. */
export function reviewBreakdown(plan: ImportPlan, g: GlyphSet = GLYPHS.unicode): string {
  const rows = reviewRowsOf(plan);
  const conflicts = rows.filter((r) => r.group !== undefined && r.class !== 'secret').length;
  const secrets = rows.filter((r) => r.class === 'secret').length;
  const ambiguous = rows.length - conflicts - secrets;
  const parts: string[] = [];
  if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
  if (secrets > 0) parts.push(`${secrets} secret${secrets === 1 ? '' : 's'}`);
  if (ambiguous > 0) parts.push(`${ambiguous} ambiguous`);
  return parts.join(` ${g.dot} `);
}

/**
 * §5.8: the source hint of one group row — the single source at 80 columns, the full list at 120, nothing at 40.
 * Display paths only (`~/.claude/CLAUDE.md`), which is all `PlanRow.source.display` ever holds.
 */
export function groupSourceHint(plan: ImportPlan, key: PlanGroupKey, tier: 'narrow' | 'full' | 'wide'): string {
  if (tier === 'narrow') return '';
  const rows = rowsOfGroup(plan, key);
  if (rows.length === 0) return '';
  const seen: string[] = [];
  for (const r of rows) if (!seen.includes(r.source.display)) seen.push(r.source.display);
  const first = seen[0] ?? '';
  if (tier === 'wide') return seen.join(', ');
  const rest = seen.length - 1;
  return rest > 0 ? `${first}, ${rest} more` : first;
}

/** The width tier a group row renders at (§5.8's three columns). */
export function importTier(width: number): 'narrow' | 'full' | 'wide' {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  return w >= 100 ? 'wide' : w >= 60 ? 'full' : 'narrow';
}

/** §12.4 S90: one group row's three cells (`memory`, `29`, the hint). */
export function groupRowCells(row: ImportGroupRow, plan: ImportPlan, width: number, g: GlyphSet = GLYPHS.unicode): readonly string[] {
  const tier = importTier(width);
  const note = row.key === 'review' ? reviewBreakdown(plan, g) : GROUP_NOTE[row.key];
  const hint = note !== '' ? note : groupSourceHint(plan, row.key, tier);
  return tier === 'narrow' ? [row.key, String(row.rows)] : [row.key, String(row.rows), hint];
}

/**
 * §5.8's 40-column row, honestly: **one** row per group, `memory  29`.
 *
 * `renderBlock`'s `table` kind stacks its cells onto two rows below `TIER_NARROW_MIN` (34 cells), and
 * `blockWidth(40)` is 30 — so at the most common narrow terminal the five-group view needed fourteen rows,
 * `CAP.import` is ten, and the painted frame ended mid-list with the `review` row and the whole keys row gone
 * (measured at 40×24). Below the narrow tier the rows are therefore pre-formatted single lines (`facts`,
 * `wrap: false`), aligned against each other exactly as the table would align them, and the row count of the
 * default view is `1 + groups + 1` at **every** width and in **every** glyph set.
 */
function groupBlockRows(state: ImportUiState, plan: ImportPlan, width: number, g: GlyphSet): BlockRow[] {
  const cells = state.groups.map((gr) => groupRowCells(gr, plan, width, g));
  if (blockTier(width) !== 'tight') return cells.map((c) => ({ kind: 'table', cells: [...c], align: ['l', 'r', 'l'] }));
  const keyCol = Math.max(0, ...cells.map((c) => cellWidth(c[0] ?? '')));
  const numCol = Math.max(0, ...cells.map((c) => cellWidth(c[1] ?? '')));
  return cells.map((c) => ({ kind: 'facts', wrap: false, segments: [`${padEndCells(c[0] ?? '', keyCol)}  ${padStartCells(c[1] ?? '', numCol)}`] }));
}

/**
 * §13.4 / §5.8: the one-row footer of every step — the keys row, or the hint that replaces it. It is a
 * `facts` row with `wrap: false` (elided right, never wrapped) for two reasons: the row count must not depend on
 * the glyph set (`overlayWant` measures one set and the component draws another, §14.2-style drift), and the
 * keys row is the row a capped overlay must never lose. Every hint text is substituted through `glyphTwin` here,
 * so `IMPORT_HINT_*` and `IMPORT_SCANNING_ROW` are unicode anchors with an `--ascii` twin by construction.
 */
function noteRow(text: string, g: GlyphSet): BlockRow {
  return { kind: 'facts', wrap: false, segments: [glyphTwin(oneLine(text), g)], role: 'dim' };
}

// ---------------------------------------------------------------------------------------
// §12.4 S91 / IMPORT-DESIGN §5.2 — the keys rows
// ---------------------------------------------------------------------------------------

/** §12.4 S91 at the widest rung; §5.8's 40-column form (`y all · Enter open · Esc`) is the narrowest. */
export function importKeysRungs(toImport: number): readonly string[] {
  return [
    `[y] import all ${toImport}   [Enter] expand a group   [r] review   [Esc] later`,
    `[y] import all ${toImport} {dot} [Enter] expand {dot} [r] review {dot} [Esc] later`,
    `y all ${toImport} {dot} Enter open {dot} r review {dot} Esc`,
    `y all {dot} Enter open {dot} Esc`,
    `y all {dot} Enter {dot} Esc`,
    `y all {dot} Esc`,
    `y {dot} Esc`,
  ];
}

/** §12.4 S91: the widest keys row that fits. */
export function importKeys(toImport: number, width: number, g: GlyphSet = GLYPHS.unicode): string {
  return fitRungIn(importKeysRungs(toImport), width, g, { dot: g.dot });
}

/** IMPORT-DESIGN §5.2: the expanded-group keys row. */
export const IMPORT_HINT_ROWS = 'Space toggles · a all · n none · Enter back · y import';
/**
 * IMPORT-DESIGN §5.2: a numbered prompt inside the review queue. The separator is a HYPHEN, not the EN DASH the
 * design's prose uses: `–` is in no glyph table, so no `--ascii` substitution could ever reach it and the row
 * would carry a unicode cell under `--ascii` (a declared §13.2-style substitution, asserted in `lines.test.ts`).
 */
export const IMPORT_HINT_PICK = 'pick 1-4 · Esc back';
/** IMPORT-DESIGN §5.2: the apply frame. */
export const IMPORT_HINT_APPLYING = 'applying … Ctrl-C stops after the current file';
/** IMPORT-DESIGN §5.2 / §7 row 75: another import holds the lock. */
export function importHintLocked(pid: number, secondsAgo: number): string {
  return `an import is applying (pid ${pid}, ${secondsAgo} s ago) — try again when it finishes`;
}
/** §5.2: the pre-plan row while `planImport` runs. */
export const IMPORT_SCANNING_ROW = 'Import — scanning your other agents … (Esc cancels; nothing is written)';
/** §12.4 S92: `/import` with an empty probe. */
export const IMPORT_NOTHING_FOUND = 'nothing to import — no claude-code, codex or cursor configuration found';
/** §7 row 59, behaviour 3: Esc closes the overlay and the plan is kept on disk. */
export function importClosedRow(importId: string, g: GlyphSet = GLYPHS.unicode): string {
  return `import closed ${g.dash} the plan is kept: jevcode import --resume ${importId}`;
}

// ---------------------------------------------------------------------------------------
// The block (D-AO): `BlockRow[]` through `renderBlock` / `blockWidth`
// ---------------------------------------------------------------------------------------

/** §5.2: the overlay's rows as `BlockRow[]`, ready for `renderBlock(rows, blockWidth(columns))`. */
export function importBlockRows(state: ImportUiState, input: ImportUiInput, columns: number, g: GlyphSet = GLYPHS.unicode): BlockRow[] {
  const width = blockWidth(columns);
  const s = state.summary;
  if (state.step === 'scanning') return [noteRow(IMPORT_SCANNING_ROW, g)];
  const head: BlockRow = { kind: 'facts', segments: [importHead(s.toImport, s.toReview, s.skipped, s.bytes, width, g)], wrap: false, role: 'accent' };
  if (state.step === 'review') {
    const queue = reviewRowsOf(input.plan);
    const at = queue[state.reviewAt];
    const rows: BlockRow[] = [head, noteRow(`review ${queue.length === 0 ? 0 : state.reviewAt + 1} of ${queue.length}`, g)];
    if (at !== undefined) {
      rows.push({ kind: 'kv', key: 'source', value: at.source.display, path: true });
      // the engine's `why` is a CODE-GENERATED sentence (`jev same_meaning p=0.41 → both kept`), so it takes the
      // glyph twin like every other generated string; `source` / `dest` are PATHS and are never rewritten (§12).
      rows.push({ kind: 'kv', key: 'why', value: glyphTwin(at.why, g) });
      if (at.dest !== null) rows.push({ kind: 'kv', key: 'dest', value: at.dest, path: true });
    }
    rows.push(noteRow(state.hint ?? IMPORT_HINT_PICK, g));
    return rows;
  }
  if (state.step === 'rows' && state.expanded !== null) {
    const rows: BlockRow[] = [head];
    for (const r of rowsOfGroup(input.plan, state.expanded)) {
      const on = !state.off.has(r.id);
      rows.push({ kind: 'table', cells: [on ? 'on' : g.dash, r.source.display, r.dest ?? g.dash] });
    }
    rows.push(noteRow(state.hint ?? IMPORT_HINT_ROWS, g));
    return rows;
  }
  if (state.step === 'applying') return [head, noteRow(state.hint ?? IMPORT_HINT_APPLYING, g)];
  if (state.step === 'done') {
    const a = state.applied;
    // §7 row 59, behaviour 2: an interrupted apply prints the SAME resume sentence the CLI's `[import]` item
    // prints (§12.4 S95's sibling, `importInterruptedItem`) — one home for the string, two sinks.
    const text = state.interrupted
      ? importInterruptedItem(a?.ok ?? 0, a?.total ?? 0, state.importId, importGlyphs(g))
      : a === null
        ? IMPORT_HINT_APPLYING
        : `applied ${a.ok} of ${a.total}${a.failed > 0 ? `, ${a.failed} failed` : ''}`;
    return [head, noteRow(text, g)];
  }
  const rows: BlockRow[] = [head, ...groupBlockRows(state, input.plan, width, g)];
  rows.push(noteRow(state.hint ?? importKeys(s.toImport, width, g), g));
  return rows;
}

/**
 * §5.2: the rendered rows (text + colour role) the Ink overlay draws and `--plain` prints, **inside the row
 * budget the slot granted**.
 *
 * `max` is what makes the overlay honest at a width where the body does not fit: `renderBlock`'s `protectTail: 1`
 * keeps the keys / hint row whatever happens, and the rows that do not fit become one `… +N more rows` footer
 * instead of being silently sliced off the end by the component (which is what dropped §12.4 S91 at 40 columns).
 * The default is `CAP.import`, the slot's own ceiling, so `overlayWant` and the component agree by construction.
 */
export function importRendered(state: ImportUiState, input: ImportUiInput, columns: number, g: GlyphSet = GLYPHS.unicode, max: number = CAP.import): RenderedRow[] {
  const rows = importBlockRows(state, input, columns, g);
  const width = blockWidth(columns);
  const budget = Math.max(1, Math.floor(Number.isFinite(max) ? max : CAP.import));
  const full = renderBlock(rows, width, g, { protectTail: 1 });
  if (full.length <= budget) return full;
  // the cap leaves room for the footer AND the protected tail, so the total is exactly `budget`
  return renderBlock(rows, width, g, { max: Math.max(0, budget - 2), protectTail: 1 });
}

/** §13.1: the one row list — `--plain`, `transcript.log` and the Ink overlay all walk this. */
export function importLines(state: ImportUiState, input: ImportUiInput, columns: number, g: GlyphSet = GLYPHS.unicode, max: number = CAP.import): string[] {
  return importRendered(state, input, columns, g, max).map((r) => r.text);
}

// ---------------------------------------------------------------------------------------
// §5.7 / §12.4 — the numbered `--plain` and screen-reader twins
// ---------------------------------------------------------------------------------------

/** §5.7: `Enter selection (1-N):` — the readline composer's existing prompt idiom, one shape for every list. */
export function importSelectionPrompt(n: number): string {
  return `Enter selection (1-${n}):`;
}

/**
 * §5.7 / §13.1: the numbered `--plain` twin of the default view. The same head, the same group rows and the same
 * counts as the Ink overlay — a number per group, then the one-key line as letters.
 */
export function importPlainLines(state: ImportUiState, input: ImportUiInput, columns = 120, g: GlyphSet = GLYPHS.unicode, opts: { prompt?: boolean } = {}): string[] {
  const s = state.summary;
  const width = blockWidth(columns);
  const out = [importHead(s.toImport, s.toReview, s.skipped, s.bytes, width, g)];
  state.groups.forEach((gr, i) => {
    const cells = groupRowCells(gr, input.plan, width, g);
    const mark = gr.key === 'review' ? '[needs you]' : gr.selectable > 0 ? '[on]' : '[--]';
    out.push(`  ${i + 1} ${cells.join('  ')}  ${mark}`.replace(/\s+$/, ''));
  });
  out.push(`  a import all ${s.toImport} ${g.dot} number opens a group ${g.dot} r review ${g.dot} q quit`);
  // §5.7: the prompt is printed ONLY when something will read the answer. `jevcode import` has no readline yet,
  // and an unanswerable `Enter selection (1-6):` on a TTY is the one case §5.7 exists to prevent.
  if (opts.prompt !== false) out.push(importSelectionPrompt(state.groups.length));
  return out;
}

/** §12.4 S89 SR: `Import: 41 to import, 9 to review, 137 skipped, 38 kibibytes` — counts spoken, no glyphs. */
export function importScreenReaderHead(toImport: number, toReview: number, skipped: number, bytes: number): string {
  return `Import: ${toImport} to import, ${toReview} to review, ${importCount(skipped)} skipped, ${importSize(bytes).replace(' KiB', ' kibibytes').replace(' MiB', ' mebibytes').replace(' B', ' bytes')}`;
}

/** §5.7 / §12.4 S90 SR: the numbered group list, spoken, no bullets. */
export function importScreenReaderLines(state: ImportUiState, opts: { prompt?: boolean } = {}): string[] {
  const s = state.summary;
  const out = [importScreenReaderHead(s.toImport, s.toReview, s.skipped, s.bytes)];
  state.groups.forEach((gr, i) => {
    out.push(`${i + 1}. ${gr.key}, ${gr.rows} ${gr.rows === 1 ? 'row' : 'rows'}${gr.key === 'review' ? ', needs you' : gr.selectable > 0 ? ', on' : ', nothing to import'}`);
  });
  if (opts.prompt !== false) out.push(importSelectionPrompt(state.groups.length));
  return out;
}

// ---------------------------------------------------------------------------------------
// §13.1: ONE producer per string — what this module deliberately does NOT declare
// ---------------------------------------------------------------------------------------

// The §5.1 probe summary (`found claude-code (43 items), codex (3 items)`) has exactly one home:
// `importProbeSummary` in `src/tui/onboarding/lines.ts`, over `ImportProbeCounts`. This module used to carry a
// second copy over `ImportProbe` with identical logic and no caller; a `ImportProbe` → `ImportProbeCounts`
// adaptation at the call site is one `.map`, and two producers of one string is what §13.1/§13.4 forbid.
