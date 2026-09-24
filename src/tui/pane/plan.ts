/**
 * The `p` tab (TUI-DESIGN §7.2 "plan ledger", F-K / F-Z / F-D): `[x] text sN done_j p.pp` accepted ·
 * `[?] … unverified` · `[ ] remaining` · `[!] replan|rejected_claim|stale_plan|human sN: text`; at ≥ 120
 * columns the evidence (`tests 41p/0f/0e`) and `open:` problem column. `done_<j>` is the engine's own id
 * (j = the claim's index among the step's judged claims, `PlanView.claimsByStep`), never fabricated.
 * The ledger glyphs are already ASCII (§14.1). Pure line builder; every row ≤ `columns`.
 */
import type { HarnessProblem, Plan, PlanItemDone, PlanUnverified } from '../../core/types.js';
import { p2 } from '../plain.js';
import { GLYPHS, fitCells, oneLineCells, padEndCells, padStartCells, stepLabelCells, truncateCells, type GlyphSet } from '../glyphs.js';
import type { PaneState, PlanView } from './model.js';

/** The empty plan tab (no `plan` event yet this run). */
export const NO_PLAN_YET = '(no plan yet)';

/** Column where the 120-column evidence / `open:` column starts (F-Z). */
const EVIDENCE_COLUMN = 70;
/** The ledger text column at ≥ 80 columns (F-K: `s4` lands in cell 52). */
const TEXT_CELLS_WIDE = 46;
/** Cells of `done_j p.pp` (`done_0 0.91`), the widest tail the narrow form reserves. */
const TAIL_CELLS = 11;

/**
 * TUI-DESIGN §7.1 / §7.2 `done_<j>`: j = the claim's index among the claims judged at `step`
 * (`claimsByStep`, folded from `step:end.record.judge.doneClaims` — the same list `src/loop/plan.ts`
 * indexes for `done_${claims.indexOf(text)}`); null when the step's claims are not known, in which
 * case the ledger prints the probability alone rather than a fabricated id.
 */
export function doneClaimIndex(view: Pick<PlanView, 'claimsByStep'>, step: number, text: string): number | null {
  const claims = view.claimsByStep?.get(step);
  if (!claims) return null;
  const j = claims.indexOf(text);
  return j >= 0 ? j : null;
}

/** `done_0 0.91` · `0.91` (claim index unknown) · `not judged` (jev-off, judged −1). */
export function judgedTail(judged: number, j: number | null): string {
  if (!(judged >= 0)) return 'not judged';
  return j === null ? p2(judged) : `done_${j} ${p2(judged)}`;
}

/** Text column: 46 cells from 80 columns (F-K); in the narrow form whatever the row leaves after `sN` and the tail (≥ 8). */
function textCells(columns: number, stepCells: number): number {
  if (columns >= 80) return TEXT_CELLS_WIDE;
  return Math.max(8, Math.min(TEXT_CELLS_WIDE, columns - 4 - 1 - stepCells - 1 - TAIL_CELLS));
}

/** The `sN` cell: right-aligned in 3 cells from 80 columns (F-K `s4` in cell 52 whatever the digit count), `stepCells` wide in the narrow form. */
function stepCell(step: number, columns: number, stepCells: number): string {
  return columns >= 80 ? `${padStartCells(`s${step}`, 3)} ` : padStartCells(`s${step}`, stepCells);
}

/** TUI-DESIGN §7.2 / §24 / F-K: `[x] text(46) sN  done_j p.pp`; F-D narrow: `[x] text sN done_j p.pp`. */
export function doneRow(item: PlanItemDone, j: number | null, columns: number, g: GlyphSet, stepCells = stepLabelCells([item.evidence.step])): string {
  return `[x] ${fitCells(oneLineCells(item.text), textCells(columns, stepCells), g)} ${stepCell(item.evidence.step, columns, stepCells)} ${judgedTail(item.evidence.judged, j)}`;
}

/** TUI-DESIGN §7.2 / §24 / F-K: `[?] text(46) sN  done_j p.pp  unverified`; the tag moves into the evidence column at ≥ 120 (F-Z) and is left to the `[?]` marker in the narrow form (F-D). */
export function unverifiedRow(item: PlanUnverified, j: number | null, columns: number, g: GlyphSet, withTag = columns >= 80 && columns < 120, stepCells = stepLabelCells([item.step])): string {
  return `[?] ${fitCells(oneLineCells(item.text), textCells(columns, stepCells), g)} ${stepCell(item.step, columns, stepCells)} ${judgedTail(item.judged, j)}${withTag ? '  unverified' : ''}`;
}

/** TUI-DESIGN §7.2 / F-K: `[!] rejected_claim s5: text` — the replan row reads `[!] replan s6 <move>: <text>` (the directive text carries its own colon; F-K, F-Z and F-D agree). */
export function problemRow(p: HarnessProblem): string {
  return `[!] ${p.kind} s${p.step}${p.kind === 'replan' ? '' : ':'} ${oneLineCells(p.text)}`;
}

/** TUI-DESIGN F-D: the plan tab's summary row when it is the second tab of the side-by-side pane — `plan  done 2  remaining 3  unverified 1  problems 1` (`problems` = harness problems, as `prob` on the rule row). */
export function planSummaryRow(plan: Plan): string {
  return `plan  done ${plan.done.length}  remaining ${plan.remaining.length}  unverified ${plan.unverified.length}  problems ${plan.harnessProblems.length}`;
}

function evidenceText(view: PlanView, step: number, unverified: boolean, g: GlyphSet): string {
  const t = view.testsByStep?.get(step);
  if (t) return `${unverified ? `unverified ${g.dot} ` : ''}evidence tests ${t.passed}p/${t.failed}f/${t.errors}e`;
  return unverified ? `unverified ${g.dot} no test evidence yet` : '';
}

/** TUI-DESIGN §7.2 `p` tab `lines(state, rows, columns)`: the ledger rows of the last `plan` event; the evidence column and the `open:` problems (filling the `[!]`/`[ ]` rows from the bottom, F-Z) at ≥ 120 columns; `(no plan yet)` when none. */
export function planRows(state: PaneState, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0 || columns <= 0) return [];
  const view = state.plan;
  if (!view) return [truncateCells(NO_PLAN_YET, columns, g)];
  const plan: Plan = view.plan;
  const wide = columns >= 120;
  const stepCells = stepLabelCells([...plan.done.map((d) => d.evidence.step), ...plan.unverified.map((u) => u.step)]);
  const unverifiedTexts = new Set(plan.unverified.map((u) => u.text));
  const lines: string[] = [];
  const extras: string[] = [];
  const ledgerRows = plan.done.length + plan.unverified.length;
  for (const item of plan.done) {
    lines.push(doneRow(item, doneClaimIndex(view, item.evidence.step, item.text), columns, g, stepCells));
    extras.push(wide ? evidenceText(view, item.evidence.step, false, g) : '');
  }
  for (const item of plan.unverified) {
    lines.push(unverifiedRow(item, doneClaimIndex(view, item.step, item.text), columns, g, columns >= 80 && !wide, stepCells));
    extras.push(wide ? evidenceText(view, item.step, true, g) : '');
  }
  for (const text of plan.remaining) {
    if (unverifiedTexts.has(text)) continue;
    lines.push(`[ ] ${oneLineCells(text)}`);
    extras.push('');
  }
  for (const p of plan.harnessProblems) {
    lines.push(problemRow(p));
    extras.push('');
  }
  if (wide) {
    // F-Z: the open problems take the evidence column of the `[!]` / `[ ]` rows from the bottom up (never a ledger row's)
    let k = 0;
    for (let i = extras.length - 1; i >= ledgerRows && k < plan.openProblems.length; i--) {
      if (extras[i] === '') extras[i] = `open: ${oneLineCells(plan.openProblems[k++] ?? '')}`;
    }
  }
  const out = lines.map((line, i) => {
    const extra = extras[i] ?? '';
    if (extra === '') return truncateCells(line, columns, g);
    return truncateCells(`${padEndCells(truncateCells(line, EVIDENCE_COLUMN - 2, g), EVIDENCE_COLUMN)}${extra}`, columns, g);
  });
  return out.slice(0, n);
}
