/**
 * Review prompt rows (TUI-DESIGN §6.1, §6.5, F6): `reviewHeaderLines(req, n, columns)` — the one
 * signature shared by Ink, `--plain` and the screen reader — its truncation ladder for n < 8, the
 * compact rows (two dimensions per row at 80 columns, three at ≥ 120, maximum-risk first, digits
 * fixed in RISK_DIMENSIONS order so `w`+digit is stable), the SR twin, and the follow-up confirm box
 * (§9.3). Pure; every row ≤ `columns`; the cut is a function, never Ink clipping.
 */
import { RISK_DIMENSIONS, type ConfirmRequest, type RiskDimension, type RiskDimensionResult, type SessionClamp } from '../../core/types.js';
import { buildRiskQuestions, riskLevelTexts } from '../../loop/stages/risk.js';
import { noulConfidence } from '../../jev/confidence.js';
import { describeAction, oneLine, p2 } from '../plain.js';
import { barAriaLabel, eighthBar } from '../bars.js';
import { GLYPHS, cellWidth, fitCells, oneLineCells, padEndCells, padStartCells, truncateCells, type GlyphSet } from '../glyphs.js';

/** The full header (§6.1 "Full header at 80 columns (8 rows)"). */
export const REVIEW_HEADER_ROWS = 8;
/** §24 "Review box" keys row at 80 columns. */
export const REVIEW_KEYS_80 = '[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline';
/** §24 "Review box" keys row at ≥ 120 columns. */
export const REVIEW_KEYS_120 = '[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run';
/** §24: the toast for any other key while the box is up. */
export const REVIEW_PENDING_TOAST = 'review pending: y n d e w · Esc declines';
/** §24: row 8 when `matchesIntent` is null. */
export const MATCHES_INTENT_NOT_JUDGED = '5 matches_intent  —  not judged this step';
/** §6.5 / §24 SR twin rows. */
export const SR_REVIEW_CHOICES = '1 approve  2 decline  3 decline with a note';
export const SR_REVIEW_PROMPT = 'Enter selection (1-3):';
/** The ruler's explanatory tail (the 120-column form adds the column legend). */
const RULER_TEXT_80 = "Jev's dominant level (why)";
const rulerText120 = (g: GlyphSet): string => `${RULER_TEXT_80}; E[k]/4; tail = P(k${g.ge}3)`;
/** Goal clip in the 80-column title (§6.1 `"<goal ≤ 40>"`). */
const GOAL_CELLS_80 = 40;
const TARGET_CELLS_80 = 30;
const TARGET_CELLS_120 = 60;
/** Width of the digit + name column (`5 matches_intent` is the longest name, 14). */
const NAME_CELLS = 14;

export type ReviewRowKey = RiskDimension | 'matches_intent';

/** TUI-DESIGN §6.1: the fixed digit of every gauge row (`1 destructive` … `4 irreversible`, `5 matches_intent`). */
export function reviewDigit(key: ReviewRowKey): number {
  if (key === 'matches_intent') return 5;
  return RISK_DIMENSIONS.indexOf(key) + 1;
}

/** TUI-DESIGN §6.2 `w`+digit: the row a digit names, or null. */
export function reviewRowForDigit(digit: number): ReviewRowKey | null {
  if (digit === 5) return 'matches_intent';
  return RISK_DIMENSIONS[digit - 1] ?? null;
}

const ZERO_DIM: RiskDimensionResult = { risk: 0, probability: 0, expected: 0, tailMass: 0, bound: 'expected', confidence: 0, level: 0 };

function dimOf(req: ConfirmRequest, dim: RiskDimension): RiskDimensionResult {
  return req.risk.dims[dim] ?? ZERO_DIM;
}

function bnd(d: RiskDimensionResult): string {
  return d.bound === 'tail' ? 'tail' : 'exp';
}

/** The dimension whose risk is the assessment's maximum (ties → RISK_DIMENSIONS order), for the title's `(bound)`. */
export function dominantDimension(req: ConfirmRequest): RiskDimension {
  let best: RiskDimension = RISK_DIMENSIONS[0] ?? 'destructive';
  let bestRisk = Number.NEGATIVE_INFINITY;
  for (const dim of RISK_DIMENSIONS) {
    const r = dimOf(req, dim).risk;
    if (Number.isFinite(r) && r > bestRisk) {
      bestRisk = r;
      best = dim;
    }
  }
  return best;
}

let matchesIntentDefinition: string | null = null;
/** The `matches_intent` Noul's `criteria.true.definition` (built once from the risk stage's question builder, so the row quotes what Jev was asked). */
export function matchesIntentText(): string {
  if (matchesIntentDefinition === null) {
    const q = buildRiskQuestions()['matches_intent'];
    let text = '';
    if (q && q.type === 'noul' && q.criteria) {
      const t = q.criteria.true;
      if (typeof t === 'string') text = t;
      else if (t !== null && typeof t === 'object' && !Array.isArray(t) && typeof t['definition'] === 'string') text = t['definition'];
    }
    matchesIntentDefinition = text.replace(/\s+/g, ' ').trim();
  }
  return matchesIntentDefinition;
}

/** The level text of a dimension's dominant level (`riskLevelTexts(evidence !== undefined)`, risk.ts). */
export function levelText(req: ConfirmRequest, dim: RiskDimension): string {
  const texts = riskLevelTexts(req.proposal.evidence !== undefined);
  const d = dimOf(req, dim);
  return (texts[dim][d.level] ?? '').replace(/\s+/g, ' ').trim();
}

/** TUI-DESIGN §6.1 row 1: `review  step N  risk R (bound)  <kind> <target> "<goal ≤ 40>"`; at ≥ 120 `(bound on <dim>)`, the full goal and a right-aligned `jev <ms>ms`. */
export function reviewTitle(req: ConfirmRequest, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const wide = columns >= 120;
  const dom = dominantDimension(req);
  const bound = wide ? `${bnd(dimOf(req, dom))} on ${dom}` : bnd(dimOf(req, dom));
  const a = describeAction(req.proposal.action);
  const target = truncateCells(oneLine(a.target), wide ? TARGET_CELLS_120 : TARGET_CELLS_80, g);
  const head = `review  step ${req.step}  risk ${p2(req.risk.risk)} (${bound})  ${a.kind} ${target}${wide ? '  ' : ' '}`;
  const jev = wide && req.jevLatencyMs !== undefined && Number.isFinite(req.jevLatencyMs) ? `jev ${Math.round(req.jevLatencyMs)}ms` : '';
  const goalRaw = oneLine(req.proposal.goal).trim();
  const goalBudget = Math.max(0, wide ? columns - cellWidth(head) - 2 - (jev ? cellWidth(jev) + 2 : 0) : Math.min(GOAL_CELLS_80, columns - cellWidth(head) - 2));
  const goal = `"${truncateCells(goalRaw, goalBudget, g)}"`;
  let line = `${head}${goal}`;
  if (jev) {
    const w = cellWidth(line);
    line = w + 2 + cellWidth(jev) <= columns ? `${padEndCells(line, columns - cellWidth(jev))}${jev}` : `${line}  ${jev}`;
  }
  return truncateCells(line, columns, g);
}

/** TUI-DESIGN §6.1 row 2 (§24 verbatim): the keys row; `[e] expand preview` and `[ctrl-c] abort run` at ≥ 120. */
export function reviewKeys(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  return truncateCells(columns >= 120 ? REVIEW_KEYS_120 : REVIEW_KEYS_80, columns, g);
}

/** The bar-column ruler `0  ┆   ┆ 1`: `┆` in cells 3 and 7 marks the 0.3/0.7 band under NO_COLOR (§6.1). */
export function barRuler(g: GlyphSet = GLYPHS.unicode): string {
  return `0  ${g.band}   ${g.band} 1`;
}

/** TUI-DESIGN §6.1 row 3: the ruler aligned to the gauge columns; at ≥ 120 it gains `P(l)  E[k]  tail`. */
export function reviewRuler(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const head = `${padEndCells('dimension', NAME_CELLS + 3)}lvl ${barRuler(g)}`;
  const line = columns >= 120 ? `${head}  risk  bnd   P(l)  E[k]  tail  conf   ${rulerText120(g)}` : `${head}  risk bnd  conf  ${RULER_TEXT_80}`;
  return truncateCells(line, columns, g);
}

/** TUI-DESIGN §6.1 rows 4–7: `<digit> <name> L<k>  <bar10 of risk>  <risk> <exp|tail> <conf>  <level text>`; the three extra numbers at ≥ 120. */
export function gaugeRow(req: ConfirmRequest, dim: RiskDimension, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const d = dimOf(req, dim);
  const wide = columns >= 120;
  const name = `${reviewDigit(dim)} ${padEndCells(dim, NAME_CELLS)}`;
  const bar = g.mode === 'sr' ? '' : `${eighthBar(d.risk, 10, g)}  `;
  const nums = wide
    ? `${padStartCells(p2(d.risk), 4)}  ${padEndCells(bnd(d), 4)}  ${padStartCells(p2(d.probability), 4)}  ${padStartCells(p2(d.expected), 4)}  ${padStartCells(p2(d.tailMass), 4)}  ${padEndCells(p2(d.confidence), 5)}  `
    : `${padStartCells(p2(d.risk), 4)} ${padEndCells(bnd(d), 4)} ${padEndCells(p2(d.confidence), 5)} `;
  const prefix = `${name} ${padEndCells(`L${d.level}`, 2)}  ${bar}${nums}`;
  const text = truncateCells(levelText(req, dim), Math.max(0, columns - cellWidth(prefix)), g);
  return truncateCells(`${prefix}${text}`.trimEnd(), columns, g);
}

/** TUI-DESIGN §6.1 row 8: `5 matches_intent  <bar of p>  <p> noul <c>~ <criteria.true definition>` or `5 matches_intent  —  not judged this step`. */
export function matchesIntentRow(req: ConfirmRequest, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const p = req.matchesIntent;
  if (p === undefined || p === null || !Number.isFinite(p)) return truncateCells(MATCHES_INTENT_NOT_JUDGED.replace('—', g.dash), columns, g);
  const wide = columns >= 120;
  const c = `${p2(noulConfidence(p))}~`;
  const bar = g.mode === 'sr' ? '' : `${eighthBar(p, 10, g)}  `;
  const na = padEndCells(g.dash, 4);
  const nums = wide ? `${padStartCells(p2(p), 4)}  noul  ${na}  ${na}  ${na}  ${c}  ` : `${padStartCells(p2(p), 4)} noul ${c} `;
  const prefix = `5 ${padEndCells('matches_intent', NAME_CELLS)} ${' '.repeat(2)}  ${bar}${nums}`;
  const text = truncateCells(matchesIntentText(), Math.max(0, columns - cellWidth(prefix)), g);
  return truncateCells(`${prefix}${text}`.trimEnd(), columns, g);
}

interface CompactEntry {
  key: ReviewRowKey;
  /** sort key: the dimension's risk, or 1 − p for matches_intent (a low p is the concern) */
  concern: number;
  text: string;
}

function compactEntries(req: ConfirmRequest): CompactEntry[] {
  const entries: CompactEntry[] = RISK_DIMENSIONS.map((dim) => {
    const d = dimOf(req, dim);
    return { key: dim, concern: Number.isFinite(d.risk) ? d.risk : 0, text: `${reviewDigit(dim)} ${dim} L${d.level} r=${p2(d.risk)} ${bnd(d)} c=${p2(d.confidence)}` };
  });
  const mi = req.matchesIntent;
  if (mi !== undefined && mi !== null && Number.isFinite(mi)) {
    entries.push({ key: 'matches_intent', concern: 1 - mi, text: `5 matches_intent p=${p2(mi)} noul c=${p2(noulConfidence(mi))}~` });
  }
  // maximum-risk first; ties keep the digit order
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.concern - a.e.concern || a.i - b.i)
    .map(({ e }) => e);
}

/** TUI-DESIGN §6.1 ladder 5..3: `count` compact rows carrying two dimensions each at 80 columns (three at ≥ 120), the maximum-risk dimension first, digits kept. */
export function compactRows(req: ConfirmRequest, count: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const per = columns >= 120 ? 3 : 2;
  const entries = compactEntries(req);
  const out: string[] = [];
  for (let i = 0; i < entries.length && out.length < count; i += per) {
    out.push(truncateCells(entries.slice(i, i + per).map((e) => e.text).join(' | '), columns, g));
  }
  return out;
}

/**
 * TUI-DESIGN §6.1 — the one signature: the review header cut to `n` rows by the ladder
 * (8 full · 7 drops the ruler · 6 drops `matches_intent` · 5..3 title, keys, n − 2 compact rows ·
 * ≤ 2 title, keys), every row ≤ `columns` cells. Never more than `n` rows. The screen-reader set
 * (§6.5 "no ruler row") never draws the ruler, so its full header is 7 rows.
 */
export function reviewHeaderLines(req: ConfirmRequest, n: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const rows = Math.floor(Number.isFinite(n) ? n : 0);
  const w = Math.floor(Number.isFinite(columns) ? columns : 0);
  if (rows <= 0 || w <= 0) return [];
  const title = reviewTitle(req, w, g);
  if (rows === 1) return [title];
  const keys = reviewKeys(w, g);
  if (rows === 2) return [title, keys];
  if (rows <= 5) return [title, keys, ...compactRows(req, rows - 2, w, g)];
  const gauges = RISK_DIMENSIONS.map((dim) => gaugeRow(req, dim, w, g));
  if (rows === 6) return [title, keys, ...gauges];
  if (rows === 7 || g.mode === 'sr') return [title, keys, ...gauges, matchesIntentRow(req, w, g)];
  return [title, keys, reviewRuler(w, g), ...gauges, matchesIntentRow(req, w, g)];
}

/** TUI-DESIGN §6.5 SR twin: the aria label replacing a gauge bar — `plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step`. */
export function reviewAriaLabel(req: ConfirmRequest, key: ReviewRowKey): string {
  if (key === 'matches_intent') {
    const p = req.matchesIntent;
    if (p === undefined || p === null || !Number.isFinite(p)) return 'matches_intent not judged this step';
    return `matches_intent ${barAriaLabel(p)}, derived confidence ${p2(noulConfidence(p))}, ${matchesIntentText()}`;
  }
  const d = dimOf(req, key);
  return `${key} level ${d.level}, risk ${p2(d.risk)} ${bnd(d)}, confidence ${p2(d.confidence)}, ${levelText(req, key)}`;
}

/** TUI-DESIGN §6.5: the screen-reader review as `<Static>` lines — title, one aria row per dimension (no ruler, no bars), `matches_intent`, then `1 approve  2 decline  3 decline with a note` and `Enter selection (1-3):`. */
export function reviewScreenReaderLines(req: ConfirmRequest, columns = 80): string[] {
  const g = GLYPHS.sr;
  const w = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80));
  return [
    reviewTitle(req, w, g),
    ...RISK_DIMENSIONS.map((dim) => `${reviewDigit(dim)} ${reviewAriaLabel(req, dim)}`),
    `5 ${reviewAriaLabel(req, 'matches_intent')}`,
    SR_REVIEW_CHOICES,
    SR_REVIEW_PROMPT,
  ].map((l) => oneLineCells(l));
}

/** TUI-DESIGN §6.1 preview tail: `…[k more preview lines · e expands]`, only when rows are hidden. */
export function previewTail(hidden: number, g: GlyphSet = GLYPHS.unicode): string {
  return `${g.ellipsis}[${Math.max(1, Math.floor(hidden))} more preview lines ${g.dot} e expands]`;
}

/** TUI-DESIGN §6.1: `confirmPreviewLines(req)` indented two spaces and cut to `rows`, the last row the tail when rows are hidden; never a blank row inside a granted preview. */
export function reviewPreviewLines(preview: readonly string[], rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0 || preview.length === 0) return [];
  const lines = preview.map((l) => `  ${oneLineCells(l)}`);
  if (lines.length <= n) return lines.map((l) => truncateCells(l, columns, g));
  const shown = lines.slice(0, n);
  shown[n - 1] = previewTail(lines.length - n + 1, g);
  return shown.map((l) => truncateCells(l, columns, g));
}

// ---------------------------------------------------------------------------------------
// §9.3 follow-up confirm box
// ---------------------------------------------------------------------------------------

/** §24 "Overlays": the follow-up box rows. */
export const FOLLOWUP_TITLE = 'follow-up would exceed the session cap';
export const FOLLOWUP_NOTE = 'Enter does nothing here. A clamped run stops at the session cap (spend_cap).';
/** The box wants 5 rows: top border with the title, keys, session line, note, bottom border (F-P). */
export const FOLLOWUP_ROWS = 5;

export interface FollowupInput extends SessionClamp {
  /** finished runs in the session (`(N runs)`) */
  runs: number;
  /** the last run's spend, null before any run ended */
  lastRunUsd: number | null;
}

/** Two-decimal money for the box (`usd2()`, §7.4). */
export function usd2(x: number): string {
  return Number.isFinite(x) ? `$${x.toFixed(2)}` : '$nan';
}

/** §24: `[y] start, run cap clamped to $x.xx   [r] raise session cap   [n]/Esc cancel`. */
export function followupKeys(input: FollowupInput): string {
  return `[y] start, run cap clamped to ${usd2(input.clampedToUsd)}   [r] raise session cap   [n]/Esc cancel`;
}

/** §24: `session $a of $b (N runs) · run cap $c · last run $d`. */
export function followupSessionLine(input: FollowupInput, g: GlyphSet = GLYPHS.unicode): string {
  const last = input.lastRunUsd === null ? '' : ` ${g.dot} last run ${usd2(input.lastRunUsd)}`;
  return `session ${usd2(input.sessionSpentUsd)} of ${usd2(input.sessionCapUsd)} (${input.runs} run${input.runs === 1 ? '' : 's'}) ${g.dot} run cap ${usd2(input.runCapUsd)}${last}`;
}

/**
 * TUI-DESIGN §9.3 / F-P: the follow-up confirm box cut to `n` rows — 5: the framed box (title in
 * the top border, keys, session line, note, bottom border); 4: title, keys, session, note unframed;
 * 3: title, keys, session line (the design's 3-row cut); 2: title, keys; 1: title. Every row ≤ `columns`.
 */
export function followupLines(input: FollowupInput, n: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const rows = Math.floor(Number.isFinite(n) ? n : 0);
  const w = Math.floor(Number.isFinite(columns) ? columns : 0);
  if (rows <= 0 || w <= 0) return [];
  const keys = followupKeys(input);
  const session = followupSessionLine(input, g);
  if (rows >= FOLLOWUP_ROWS && w >= 20) {
    const inner = w - 4; // `│ ` + text + ` │`
    const top = `${g.boxTopLeft} ${FOLLOWUP_TITLE} `;
    const topLine = cellWidth(top) + 1 <= w ? `${top}${g.boxHorizontal.repeat(w - cellWidth(top) - 1)}${g.boxTopRight}` : truncateCells(`${g.boxTopLeft} ${FOLLOWUP_TITLE}`, w, g);
    const framed = (s: string): string => `${g.boxVertical} ${fitCells(s, inner, g)} ${g.boxVertical}`;
    return [topLine, framed(keys), framed(session), framed(FOLLOWUP_NOTE), `${g.boxBottomLeft}${g.boxHorizontal.repeat(w - 2)}${g.boxBottomRight}`];
  }
  const plain = [FOLLOWUP_TITLE, keys, session, FOLLOWUP_NOTE];
  return plain.slice(0, Math.min(rows, 4)).map((l) => truncateCells(l, w, g));
}
