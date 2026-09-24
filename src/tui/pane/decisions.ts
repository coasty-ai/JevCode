/**
 * The `d` tab (TUI-DESIGN §7.2 "decisions" row): `s7 stage(8) id(16) label(6) bar10 [!]p.pp  c c.cc[~]  [verdict]`
 * at 80 columns (F-B), `latencyMs` and `consumedBy` (`(near)` suffix) at ≥ 120 (F-J), and the narrow form
 * (< 80 columns and the 59-cell half, F-D) that hides `c` and keeps `p` and the verdict word (A100).
 * Pure line builder; every row ≤ `columns`; the `--ascii` twin renders every glyph through the set.
 */
import { p2 } from '../plain.js';
import { barAriaLabel, eighthBar } from '../bars.js';
import { GLYPHS, cellWidth, fitCells, glyphTwin, oneLineCells, padEndCells, padStartCells, stepLabelCells, truncateCells, type GlyphSet } from '../glyphs.js';
import type { DecisionRow, PaneState } from './model.js';

/** §24 "Pane rows": the empty decisions tab. */
export const NO_DECISIONS_YET = '(no decisions yet)';

/** F-J: the latency column ends in this cell (`231ms` starts at 74 after `chosen` and five spaces) and `consumedBy` starts two cells later, for a 2-cell step label; a 3-cell label shifts every column by one. */
const LATENCY_END_CELL = 79;
/** F-D: the stage and id of the narrow row share these cells (stage padded to at least 7, so `complete` still fits). */
const NARROW_STAGE_ID_CELLS = 23;

/** The verdict word: risk verdicts bracketed (`[ok]`), choice verdicts bare (`chosen`), none → ''. */
export function verdictWord(v: DecisionRow['verdict']): string {
  switch (v) {
    case 'ok':
    case 'review':
    case 'block':
      return `[${v}]`;
    case 'chosen':
    case 'overridden':
    case 'fallback':
      return v;
    default:
      return '';
  }
}

function pCell(row: DecisionRow): string {
  return `${row.near ? '!' : ' '}${padStartCells(p2(row.p), 4)}`;
}

/**
 * TUI-DESIGN §7.2 / §24 / F-B: one decisions row in the 80-column form `s7 stage(8) id(16) label(6) bar10 [!]p.pp  c c.cc[~]  [verdict]`,
 * plus the 120-column latency and `consumedBy` columns (F-J: `231ms` right-aligned to cell 79, the rule from cell 81, `(near)` when set);
 * `stepCells` is the `sN` width shared by the rows shown (2 up to s9, 3 from s10); SR mode drops the bar (the aria label carries it).
 */
export function decisionRowText(row: DecisionRow, columns: number, g: GlyphSet = GLYPHS.unicode, stepCells = stepLabelCells([row.step])): string {
  const step = padEndCells(`s${row.step}`, stepCells);
  const stage = fitCells(row.stage, 8, g);
  const id = fitCells(oneLineCells(row.id), 16, g);
  const label = fitCells(oneLineCells(row.label), 6, g);
  const bar = g.mode === 'sr' ? '' : `${eighthBar(row.p, 10, g)} `;
  const c = `c ${padStartCells(p2(row.c), 4)}${row.cDerived ? '~' : ' '}`;
  const verdict = verdictWord(row.verdict);
  let line = `${step} ${stage} ${id} ${label} ${bar}${pCell(row)}  ${c}  ${verdict}`.trimEnd();
  if (columns >= 120) {
    const latencyEnd = LATENCY_END_CELL + (stepCells - 2) - (g.mode === 'sr' ? 11 : 0);
    const ms = `${Math.round(Number.isFinite(row.latencyMs) ? row.latencyMs : 0)}ms`;
    line = `${padEndCells(line, latencyEnd - 6)}${padStartCells(ms, 6)}  ${glyphTwin(row.consumedBy, g)}${row.near ? ' (near)' : ''}`;
  }
  return truncateCells(line.trimEnd(), columns, g);
}

/**
 * TUI-DESIGN §7.2 / A100 / F-D: the narrow row (the 59-cell half or < 80 columns) — `s3 stage id label(5) bar10 [!]p.pp verdict`,
 * stage and id sharing 23 cells (stage at least 7 wide, so `complete` keeps its name), no `c`; `!` takes the separator cell before `p`.
 */
export function decisionRowNarrow(row: DecisionRow, columns: number, g: GlyphSet = GLYPHS.unicode, stepCells = stepLabelCells([row.step])): string {
  const step = padEndCells(`s${row.step}`, stepCells);
  const stage = padEndCells(truncateCells(row.stage, 8, g), 7);
  const id = fitCells(oneLineCells(row.id), NARROW_STAGE_ID_CELLS - cellWidth(stage) - 1, g);
  const label = fitCells(oneLineCells(row.label), 5, g);
  const bar = g.mode === 'sr' ? '' : eighthBar(row.p, 10, g);
  const line = `${step} ${stage} ${id} ${label} ${bar}${row.near ? '!' : ' '}${padStartCells(p2(row.p), 4)} ${verdictWord(row.verdict)}`;
  return truncateCells(line.trimEnd(), columns, g);
}

/** TUI-DESIGN §7.2 SR twin: the row's aria label (`intent intent edit, probability 0.64 of 1, confidence 0.55, chosen`). */
export function decisionRowAriaLabel(row: DecisionRow): string {
  const parts = [`step ${row.step}`, row.stage, oneLineCells(row.id), row.label, barAriaLabel(row.p), `confidence ${p2(row.c)}${row.cDerived ? ' derived' : ''}`];
  if (row.near) parts.push(`near threshold ${row.near.threshold}`);
  const v = verdictWord(row.verdict).replace(/[[\]]/g, '');
  if (v) parts.push(v);
  return parts.join(', ');
}

/** TUI-DESIGN §7.2 `d` tab `lines(state, rows, columns)`: the newest `rows` DecisionRows, newest last; `(no decisions yet)` when empty. */
export function decisionRows(state: PaneState, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0 || columns <= 0) return [];
  if (state.rows.length === 0) return [truncateCells(NO_DECISIONS_YET, columns, g)];
  const shown = state.rows.slice(-n);
  const stepCells = stepLabelCells(shown.map((r) => r.step));
  return shown.map((row) => (columns < 80 ? decisionRowNarrow(row, columns, g, stepCells) : decisionRowText(row, columns, g, stepCells)));
}
