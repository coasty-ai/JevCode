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
import { confirmPreviewLines, describeAction, oneLine, p2 } from '../plain.js';
import { WITHHELD_ROW_TEXT, diffRows, moreRowText, type DiffRow, type DiffRowKind } from '../diff/rows.js';
import type { ColorRole } from '../theme.js';
import { diffNumbersAbsolute, editSummary, editTargetText, fileTouchText } from '../diff/summary.js';
// §6.3 edge 8: the secret denylist. `isSecretPath` is purely lexical (`sandbox/paths.ts:120–135` — "safe to run
// over a 5,000-entry listing per keystroke without touching disk"), so it is legal on the first-frame path.
import { isSecretPath } from '../../sandbox/paths.js';
import { barAriaLabel, eighthBar } from '../bars.js';
import { GLYPHS, cellWidth, fitCells, oneLineCells, padEndCells, padStartCells, truncateCells, type GlyphSet } from '../glyphs.js';
import { cardBottom, cardRow, cardTop, CARD_TITLE_MARGIN } from '../card.js';
// TUI-DESIGN-4 §2.6 (P-R7): `fitRung` is the one cross-slot rung helper and `src/tui/fit.ts` is its home module
import { fillRung, fitRungIn } from '../fit.js';
import { DEFAULT_BINDINGS, displayKey, type Bindings } from '../keys/bindings.js';

/** The full header (§6.1 "Full header at 80 columns (8 rows)"). */
export const REVIEW_HEADER_ROWS = 8;
/**
 * TUI-DESIGN-4 §2.6 (P-R7, D5) — the five rungs of the review keys row, **widest first** and written as
 * *templates*: `fitRung` picks the widest one that fits the card's inner width, and the letters are filled from the
 * **effective bindings** (`Bindings.keysOf`), never from a literal, so a rebound approve key prints the right
 * letter *and* the rung that is chosen still fits (§2.6 edge 4). `{abort}` is dropped — not truncated — when no run
 * is live (edge 5). Measured at the default bindings: 113 / 76 / 55 / 42 / 15 cells (§12 "Review keys rungs").
 *
 * The defect: `reviewKeys` picked `REVIEW_KEYS_120` at `columns >= 120` and hard-truncated everything else, so at
 * 40 columns the reviewer read `[y] approve [n] decline [d] decline+not…` — `[e] expand`, `[w]1-5 why` and
 * **`[esc] decline`** were invisible on the one row a reviewer must read.
 */
export const REVIEW_KEYS_RUNGS: readonly string[] = [
  '[{approve}] approve  [{decline}] decline  [{note}] decline+note  [{expand}] expand preview  [{why}]1-5 why  [{esc}] decline      {abort}',
  '[{approve}] approve [{decline}] decline [{note}] decline+note [{expand}] expand [{why}]1-5 why [{esc}] decline',
  '[{approve}] ok [{decline}] no [{note}] note [{expand}] expand [{why}] why [{esc}] decline',
  '{approve} ok · {decline} no · {note} note · {expand} exp · {why} why · {esc}',
  '{approve}/{decline}/{note}/{expand}/{why} · {esc}',
];

/** §2.6 edge 4: the rung slots and the action each is filled from. `esc` and `abort` are reserved (TD §6.2 invariant). */
export const REVIEW_KEY_SLOTS: Readonly<Record<string, string>> = {
  approve: 'review:approve',
  decline: 'review:decline',
  note: 'review:declineNote',
  expand: 'review:expand',
  why: 'review:why',
};

/** The default fill — what every rung's documented width in §12 was measured with. */
export const REVIEW_KEYS_DEFAULT_FILL: Readonly<Record<string, string | null>> = { approve: 'y', decline: 'n', note: 'd', expand: 'e', why: 'w', esc: 'esc', abort: '[ctrl-c] abort run' };

/** §24 "Review box" keys row at 80 columns — rung 2, rendered at the default bindings (76 cells). */
export const REVIEW_KEYS_80 = fillRung(REVIEW_KEYS_RUNGS[1] ?? '', REVIEW_KEYS_DEFAULT_FILL);
/** §24 "Review box" keys row at ≥ 120 columns — rung 1, rendered at the default bindings (113 cells). */
export const REVIEW_KEYS_120 = fillRung(REVIEW_KEYS_RUNGS[0] ?? '', REVIEW_KEYS_DEFAULT_FILL);
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

/**
 * TUI-DESIGN-5 §4.6 (D-AM) / contract 1.5 §3.7 [D4]: the confirm is a **manifest proposal**, not an action.
 * `headline` is the discriminant — not `badge`, not `title` — because it is the field OR §3.7 defines as present
 * on exactly the manifest shape, and it is the one whose presence must also refuse `review:why`.
 */
export function isProposalConfirm(req: ConfirmRequest): boolean {
  return req.headline !== undefined && req.headline.length > 0;
}

/**
 * §4.6: the five render branches **substitute** rows, they never add any — so `CONFIRM_HEADER_ROWS = 8`
 * (`src/tui/plain.ts`) is unchanged and every rung of both ladders keeps its exact row count at n = 8 … 2.
 * `band(req, n)` is the headline cut/padded to exactly `n` rows: `''` pads, so a one-row headline in an
 * eight-row rung still produces eight rows and the gauge band is simply blank below it.
 */
function bandRowCount(rows: number, columns: number, g: GlyphSet, matchesIntent: boolean, card: boolean): number {
  const fixed = card ? 3 : 2;
  const body = Math.max(0, rows - fixed);
  if (card ? rows === 3 : rows <= 2) return 0;
  if (card ? rows <= 6 : rows <= 5) {
    // `compactRows` packs two dimensions per row at 80 columns, three at ≥ 120, and stops when it runs out
    const entries = RISK_DIMENSIONS.length + (matchesIntent ? 1 : 0);
    return Math.min(body, Math.ceil(entries / (columns >= 120 ? 3 : 2)));
  }
  if (card ? rows === 7 : rows === 6) return RISK_DIMENSIONS.length;
  if ((card ? rows === 8 : rows === 7) || g.mode === 'sr') return RISK_DIMENSIONS.length + 1;
  return RISK_DIMENSIONS.length + (card ? 2 : 2);
}

function headlineBand(req: ConfirmRequest, n: number, columns: number, g: GlyphSet): string[] {
  const want = Math.max(0, Math.floor(n));
  const src = req.headline ?? [];
  const out: string[] = [];
  for (let i = 0; i < want; i++) out.push(truncateCells(oneLineCells(src[i] ?? ''), columns, g));
  return out;
}

/** §4.6 / §7 row 51: `badge` (`agent tui-rows`) is rendered in the header **before** the title, so nobody approves the wrong child. */
function withBadge(req: ConfirmRequest, title: string, columns: number, g: GlyphSet): string {
  const badge = req.badge;
  if (badge === undefined || badge === '') return title;
  return truncateCells(`${oneLineCells(badge)} ${g.dot} ${title}`, columns, g);
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

/**
 * TUI-DESIGN-4 §6.1: the title's target, built in the caller's glyph set — `editTargetText` for the three edit
 * kinds (so a `patch` names its files instead of reading `18 line unified diff`, A6-1) and `describeAction`'s own
 * target for `read` / `run` / `done`. The glyph set matters: the counts carry `−` (U+2212), whose ASCII twin is `-`.
 */
export function titleTarget(req: ConfirmRequest, cells: number, g: GlyphSet): string {
  const action = req.proposal.action;
  const summary = editSummary(action);
  if (summary !== null) {
    const text = editTargetText(summary, cells, g);
    if (text !== '') return text;
  }
  return truncateCells(oneLine(describeAction(action).target), cells, g);
}

/** TUI-DESIGN §6.1 row 1: `review  step N  risk R (bound)  <kind> <target> "<goal ≤ 40>"`; at ≥ 120 `(bound on <dim>)`, the full goal and a right-aligned `jev <ms>ms`. */
export function reviewTitle(req: ConfirmRequest, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  // TUI-DESIGN-5 §4.6 / contract 1.5 [D5]: a supplied `title` replaces the computed one VERBATIM (cut to
  // `columns`), and `dominantDimension` / `dimOf` are never called — a manifest confirm carries a synthetic
  // `risk` whose numbers would be a lie on the row (§4.6's property).
  if (req.title !== undefined && req.title !== '') return truncateCells(withBadge(req, oneLineCells(req.title), columns, g), columns, g);
  const wide = columns >= 120;
  const dom = dominantDimension(req);
  const bound = wide ? `${bnd(dimOf(req, dom))} on ${dom}` : bnd(dimOf(req, dom));
  const a = describeAction(req.proposal.action);
  const target = titleTarget(req, wide ? TARGET_CELLS_120 : TARGET_CELLS_80, g);
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

/**
 * TUI-DESIGN-2 §4.7 / §12 "Cards": the review card's title edge text — `review · step 7 · risk 0.44 (tail) · edit src/a.py
 * "<goal ≤ 40>"`; at ≥ 120 `(tail on <dim>)`, the full goal and ` · jev <ms>ms`. The card's top edge cuts it to `columns − 6`.
 */
export function reviewCardTitle(req: ConfirmRequest, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  // TUI-DESIGN-5 §4.6 / contract 1.5 [D5]: the same substitution as `reviewTitle` (the card cuts it to `columns − 6`)
  if (req.title !== undefined && req.title !== '') return withBadge(req, oneLineCells(req.title), columns, g);
  const wide = columns >= 120;
  const dom = dominantDimension(req);
  const bound = wide ? `${bnd(dimOf(req, dom))} on ${dom}` : bnd(dimOf(req, dom));
  const a = describeAction(req.proposal.action);
  const target = titleTarget(req, wide ? TARGET_CELLS_120 : TARGET_CELLS_80, g);
  const goalRaw = oneLine(req.proposal.goal).trim();
  const goal = wide ? goalRaw : truncateCells(goalRaw, GOAL_CELLS_80, g);
  const jev = wide && req.jevLatencyMs !== undefined && Number.isFinite(req.jevLatencyMs) ? ` ${g.dot} jev ${Math.round(req.jevLatencyMs)}ms` : '';
  return `review ${g.dot} step ${req.step} ${g.dot} risk ${p2(req.risk.risk)} (${bound}) ${g.dot} ${a.kind} ${target} "${goal}"${jev}`;
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §6.3 (D-Z): the review card's diff preview
// ---------------------------------------------------------------------------------------

/** §6.3 item 1: the summary block names at most this many files before `… +N more files`. */
export const REVIEW_SUMMARY_FILES = 5;
/** §6.3 edge 2: the card builds from the `Action`, bypassing `clipDetail`'s 60-line clip — but never unboundedly. */
export const REVIEW_DIFF_HARD_CAP = 400;

/** §6.3 item 3: `…[+N rows · e expands to M]` — the row that tells the truth about `e` (closes A6-11). */
export function reviewDiffTail(hidden: number, expandsTo: number, g: GlyphSet = GLYPHS.unicode): string {
  return moreRowText(hidden, expandsTo, g);
}

/** §6.2 / §6.4: a preview row and the colour role it takes; `null` is the terminal's default foreground. */
export interface ReviewPreviewRow {
  text: string;
  role: ColorRole | null;
}

/** §6.2: the one mapping from a `DiffRow`'s kind to a `ColorRole` — every role's marker is already in the text. */
export function diffRowRole(kind: DiffRowKind): ColorRole | null {
  switch (kind) {
    case 'add':
      return 'added';
    case 'del':
      return 'removed';
    case 'hunk':
    case 'file':
      return 'hunk';
    case 'meta':
    case 'more':
      return 'diffMeta';
    case 'ctx':
      return null;
  }
}

interface PreviewBody {
  rows: ReviewPreviewRow[];
  /** the rows `e` would grant — the TRUE total, not the post-`clipDetail` one */
  total: number;
}

const previewMemo = new WeakMap<object, Map<string, PreviewBody>>();

/**
 * §6.3: the card's preview body, uncapped — the summary block first when the action touches ≥ 2 files, then the
 * hunks of the **first** file with line numbers on and the `diff --git` / `index` / `---` / `+++` plumbing
 * collapsed (that alone gives the card back 4 of its 8 rows, A6-8). Memoised per `Action` × width × glyph mode, so
 * a card that re-renders on every frame counts a 5 000-line patch once.
 */
/**
 * §6.3 edge 8: a file on the secret denylist shows its path and `content withheld (secret path)` — never a line of
 * it. The card, the `--plain` confirmer's stdout and the screen-reader twin all build from the `Action` now, so a
 * proposal writing `.env` would otherwise render every added line of it into all three. Lexical only: no workspace
 * root and no configured store list are available here, so it is the **basename** rule that applies (`.env`,
 * `.env.*`, `.netrc`, `*.pem`, `*.key`, `id_*`), which is the rule that catches a model-proposed path.
 */
export function withheldPath(path: string): boolean {
  return isSecretPath('/', path, []);
}

function previewBody(req: ConfirmRequest, columns: number, g: GlyphSet): PreviewBody {
  // TUI-DESIGN-5 §4.6 [G2]: a manifest confirm's body is PRE-RENDERED — `req.body`, not a diff of a synthetic
  // action — so the memo, `editSummary` and `diffRows` are all bypassed and no row can derive from `proposal`.
  if (isProposalConfirm(req)) {
    const body = (req.body ?? []).map((l) => ({ text: `  ${truncateCells(oneLineCells(l), Math.max(1, columns - 2), g)}`, role: null }));
    return { rows: body, total: body.length };
  }
  const action = req.proposal.action;
  const key = `${columns}:${g.mode}`;
  let per = previewMemo.get(action);
  if (per === undefined) {
    per = new Map<string, PreviewBody>();
    previewMemo.set(action, per);
  }
  const hit = per.get(key);
  if (hit !== undefined) return hit;

  const rows: ReviewPreviewRow[] = [];
  const summary = editSummary(action);
  const files = summary?.files ?? [];
  const totalFiles = files.length + (summary?.truncatedFiles ?? 0);
  if (summary !== null && totalFiles >= 2) {
    for (const f of files.slice(0, REVIEW_SUMMARY_FILES)) rows.push({ text: `  ${fileTouchText(f, Math.max(1, columns - 2), g)}`, role: null });
    if (totalFiles > REVIEW_SUMMARY_FILES) rows.push({ text: `  ${g.ellipsis} +${totalFiles - REVIEW_SUMMARY_FILES} more files`, role: 'diffMeta' });
  }
  const d = describeAction(action);
  let extra = 0;
  if (d.preview !== '') {
    const body: DiffRow[] = diffRows(d.preview, {
      columns: Math.max(1, columns - 2),
      maxRows: REVIEW_DIFF_HARD_CAP,
      g,
      // §14.2 review item 8: an `edit`'s two sides are a snippet, so `unifiedDiff` numbers them from 1 — printing
      // `1` for a change at line 400 of the file, with the `old  new` heading standing where the `@@ -400,7 …` row
      // would have been, tells the reviewer something untrue. An `edit` keeps its `@@` row and drops the columns.
      lineNumbers: diffNumbersAbsolute(action),
      fileRow: 'fence',
      firstFileOnly: true,
      withhold: withheldPath,
    });
    if (body.length === 0) {
      // not a diff (a `run` command, a `done` summary): today's plain preview, which is still never a blank row
      const secret = files.some((f) => withheldPath(f.path));
      if (secret) rows.push({ text: `  ${WITHHELD_ROW_TEXT}`, role: 'diffMeta' });
      else for (const l of confirmPreviewLines(req)) rows.push({ text: `  ${oneLineCells(l)}`, role: null });
    } else {
      const last = body[body.length - 1];
      extra = last !== undefined && last.kind === 'more' ? (last.hidden ?? 0) : 0;
      for (const r of body) if (r.kind !== 'more') rows.push({ text: `  ${r.text}`, role: diffRowRole(r.kind) });
    }
  }
  // §6.3 edge 3: a `write` preview never ends with a blank row (its content ends `\n` → a trailing '')
  while (rows.length > 0 && (rows[rows.length - 1]?.text ?? '').trim() === '') rows.pop();
  const out: PreviewBody = { rows, total: rows.length + extra };
  per.set(key, out);
  return out;
}

/** §6.3 / §2.1: the rows `LayoutInput.previewWant` should ask for — the real hunk size, not `old + new + 2`. */
export function reviewPreviewWant(req: ConfirmRequest, columns = 80): number {
  return previewBody(req, Math.max(1, Math.floor(columns)), GLYPHS.unicode).total;
}

/**
 * §6.3: the preview rows granted by the layout, with §6.3 item 3's truthful tail. There is **no `/diff <n>` pointer
 * on a pending card**: the review overlay swallows printable keys (§2.7 edge 6), so `/diff 4` cannot be typed while
 * the card is up, and at review time step 4 is *pre*-apply, so `/diff 4` has no checkpoint image at all.
 */
export function reviewDiffRoleRows(req: ConfirmRequest, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): ReviewPreviewRow[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  const w = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 0));
  if (n === 0) return [];
  const body = previewBody(req, w, g);
  if (body.rows.length === 0) return [];
  const cut = (r: ReviewPreviewRow): ReviewPreviewRow => ({ text: truncateCells(r.text, w, g), role: r.role });
  if (body.total <= n) return body.rows.slice(0, n).map(cut);
  const shown = body.rows.slice(0, Math.max(0, n - 1));
  shown.push({ text: reviewDiffTail(body.total - shown.length, body.total, g), role: 'diffMeta' });
  return shown.map(cut);
}

/** §6.3 / §6.10: the same rows as text — what the card body and the `--plain` readline twin print. */
export function reviewDiffLines(req: ConfirmRequest, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  return reviewDiffRoleRows(req, rows, columns, g).map((r) => r.text);
}

/** §6.3 (A6-22): cut a card title without orphaning the goal's opening quote — `"<goal…>"`, never `"<goal…`. */
export function closeTitleQuote(title: string, cells: number, g: GlyphSet = GLYPHS.unicode): string {
  const cut = truncateCells(title, cells, g);
  if (cut === title) return title;
  const quotes = (cut.match(/"/g) ?? []).length;
  if (quotes % 2 === 0) return cut;
  const room = cellWidth(cut) + 1 <= cells ? cut : truncateCells(cut, Math.max(0, cells - 1), g);
  return `${room}"`;
}

/**
 * TUI-DESIGN-2 §4.7: the boxed review card — title edge · keys row (the `d` note field replaces it) · ruler · four gauges ·
 * `5 matches_intent` · `previewRows` preview rows indented two cells (with the `…[k more preview lines · e expands]` tail) ·
 * bottom edge. The ladder over the card's `n` rows: n ≥ 9 full · 8 drops the ruler · 7 drops matches_intent · 6..4 title
 * edge, keys, n − 3 compact rows, bottom edge · 3 title edge, keys, bottom edge · n ≤ 2 → the flat ladder
 * (`reviewHeaderLines`). The cut is a function, never Ink clipping; every row is exactly `columns` cells (the flat rows ≤).
 */
export function reviewCardLines(req: ConfirmRequest, n: number, previewRows: number, columns: number, g: GlyphSet = GLYPHS.unicode, note?: { text: string; gate: string | null; spans?: readonly { start: number; end: number }[] } | null): string[] {
  const rows = Math.floor(Number.isFinite(n) ? n : 0);
  const w = Math.floor(Number.isFinite(columns) ? columns : 0);
  if (rows <= 0 || w <= 0) return [];
  if (rows <= 2) return reviewHeaderLines(req, rows, w, g);
  const inner = Math.max(1, w - 4);
  const keys = note !== undefined && note !== null ? (note.gate !== null ? note.gate : `${NOTE_LABEL_TEXT}${note.text}`) : reviewKeys(inner, g);
  let body: string[];
  // TUI-DESIGN-5 §4.6 (D-AM): the same substitution inside the card — the headline fills the band, the row count
  // of every rung (n ≥ 9 full · 8 no ruler · 7 no matches_intent · 6..4 compact · 3 keys only) is unchanged.
  if (isProposalConfirm(req)) body = [keys, ...headlineBand(req, bandRowCount(rows, inner, g, req.matchesIntent !== undefined && req.matchesIntent !== null && Number.isFinite(req.matchesIntent), true), inner, g)];
  else if (rows === 3) body = [keys];
  else if (rows <= 6) body = [keys, ...compactRows(req, rows - 3, inner, g)];
  else {
    const gauges = RISK_DIMENSIONS.map((dim) => gaugeRow(req, dim, inner, g));
    if (rows === 7) body = [keys, ...gauges];
    else if (rows === 8 || g.mode === 'sr') body = [keys, ...gauges, matchesIntentRow(req, inner, g)];
    else body = [keys, reviewRuler(inner, g), ...gauges, matchesIntentRow(req, inner, g)];
  }
  // §6.3: the preview is built by `diffRows` from the Action, so `clipDetail`'s 60-line clip is bypassed and the tail
  // tells the truth. TUI-DESIGN-5 §4.6 [G2]: a manifest confirm has no Action worth diffing — `describeAction('read')
  // .preview` is the empty string, which is the blank body the four fields exist to fix — so `body` replaces it.
  const preview = isProposalConfirm(req) ? reviewPreviewLines(confirmPreviewLines(req), previewRows, inner, g) : reviewDiffLines(req, previewRows, inner, g);
  const title = closeTitleQuote(reviewCardTitle(req, w, g), Math.max(0, w - CARD_TITLE_MARGIN), g);
  return [cardTop(title, w, g), ...body.map((b) => cardRow(b, w, g)), ...preview.map((l) => cardRow(l, w, g)), cardBottom(w, g)];
}

/** §6.2 / §24: the note field label (mirrors `NOTE_LABEL` in composer/Composer.tsx, which this Ink-free module cannot import). */
export const NOTE_LABEL_TEXT = 'note (≤ 600, Enter sends, Esc cancels): ';

/** §2.6 edge 4: the letters of the five rung slots, taken from the effective bindings (a missing binding keeps the default). */
export function reviewKeyFill(bindings: Bindings = DEFAULT_BINDINGS, opts: { live?: boolean } = {}): Record<string, string | null> {
  const fill: Record<string, string | null> = { ...REVIEW_KEYS_DEFAULT_FILL };
  for (const [slot, id] of Object.entries(REVIEW_KEY_SLOTS)) {
    const key = bindings.keysOf.get(id)?.[0];
    if (key !== undefined && key !== '') fill[slot] = displayKey(key, true).toLowerCase().replace(/\+/g, '-');
  }
  // edge 5: `[ctrl-c] abort run` only while a run is live — the WHOLE clause is one slot (brackets included), so
  // dropping it leaves no `[]` behind, and `fillRung` right-trims the six-space run that led to it
  if (opts.live === false) fill['abort'] = null;
  return fill;
}

/**
 * TUI-DESIGN §6.1 row 2 + TUI-DESIGN-4 §2.6 (P-R7): the keys row as a **ladder**. `columns` is the row's own width
 * — the card's inner width (`columns − 4`) at the boxed tier, the terminal width at the flat one. `truncateCells`
 * stays only as a last resort, for a row narrower than the 15-cell rung.
 */
export function reviewKeys(columns: number, g: GlyphSet = GLYPHS.unicode, opts: { bindings?: Bindings; live?: boolean } = {}): string {
  const cells = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  const fill = opts.bindings === undefined && opts.live === undefined ? REVIEW_KEYS_DEFAULT_FILL : reviewKeyFill(opts.bindings ?? DEFAULT_BINDINGS, opts);
  return truncateCells(fitRungIn(REVIEW_KEYS_RUNGS, cells, g, fill), cells, g);
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
  // TUI-DESIGN-5 §4.6 (D-AM): the manifest branch SUBSTITUTES the band — the headline fills exactly the rows the
  // ruler + four gauges + matches_intent would have taken, so every rung from n = 8 down to n = 2 keeps its row
  // count and `CONFIRM_HEADER_ROWS` never moves. Nothing derived from `proposal` or `risk` is drawn.
  if (isProposalConfirm(req)) return [title, keys, ...headlineBand(req, bandRowCount(rows, w, g, req.matchesIntent !== undefined && req.matchesIntent !== null && Number.isFinite(req.matchesIntent), false), w, g)];
  if (rows <= 5) return [title, keys, ...compactRows(req, rows - 2, w, g)];
  const gauges = RISK_DIMENSIONS.map((dim) => gaugeRow(req, dim, w, g));
  if (rows === 6) return [title, keys, ...gauges];
  if (rows === 7 || g.mode === 'sr') return [title, keys, ...gauges, matchesIntentRow(req, w, g)];
  return [title, keys, reviewRuler(w, g), ...gauges, matchesIntentRow(req, w, g)];
}

/**
 * TUI-DESIGN-5 §4.6 (`CD §F` to-do 2) / §12.3 S65 extended: `review:why` is the `w`-then-`1–5` chord that explains
 * ONE risk dimension. A manifest confirm has **no** risk dimensions — that is the whole point of §4.6's property —
 * so the chord must refuse rather than index into an empty array. `headline` is the discriminant (`isProposalConfirm`).
 *
 * **Deviation from §4.6's literal string, recorded in the round-5 report.** The design writes
 * `…; [Enter] approves, [d] declines`, but TD §6.2's ratified review invariant — re-run as a gate every round, and
 * §11 keeps it — is *only `y` approves, Enter is inert, there is no default*. Telling a reviewer that Enter approves
 * is false in this build and is exactly the trap the invariant exists to prevent, so the row names `y`.
 */
export const REVIEW_WHY_REFUSAL = 'no risk dimensions on this card — this is a proposal, not an action; [y] approves, [d] declines';

/** §4.6: the refusal for this request, or null when `review:why` may run (every non-manifest confirm). */
export function reviewWhyRefusal(req: ConfirmRequest): string | null {
  return isProposalConfirm(req) ? REVIEW_WHY_REFUSAL : null;
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

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §6.10: the screen-reader twin of the change
// ---------------------------------------------------------------------------------------

/** §6.10: the spoken diff is bounded at this many `line …` sentences, then the tail sentence. */
export const SR_DIFF_ROWS = 12;

const LETTER_WORD: Readonly<Record<string, string>> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', B: 'binary' };

/** §6.10: `calc/ops.py` → `calc slash ops dot py` — a reader should hear a path, not spell one. */
export function spokenPath(path: string): string {
  return path.split('/').join(' slash ').split('.').join(' dot ').replace(/\s+/g, ' ').trim();
}

/** §6.10: signs are spoken as words, so `return a - b` and `return a + b` do not sound identical. */
export function spokenCode(text: string): string {
  return text.replace(/\+/g, ' plus ').replace(/-/g, ' minus ').replace(/\s+/g, ' ').trim();
}

function kib(n: number): string {
  const v = n / 1024;
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} kibibytes`;
}

/**
 * §6.10 (the defect this closes: `reviewScreenReaderLines` omitted the preview **entirely**, so an SR user was never
 * read a single line of the change they were approving). Inserted between the aria rows and the choices.
 */
export function reviewDiffScreenReaderLines(req: ConfirmRequest): string[] {
  const action = req.proposal.action;
  const summary = editSummary(action);
  if (summary === null) return [];
  const files = summary.files;
  const totalFiles = files.length + summary.truncatedFiles;
  const out: string[] = [`change: ${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${summary.added} line${summary.added === 1 ? '' : 's'} added, ${summary.deleted} removed`];
  const first = files[0];
  if (first !== undefined) {
    if (first.binary === true) {
      out.push(`binary file, ${kib(first.bytesFrom ?? 0)} before, ${kib(first.bytesTo ?? 0)} after`);
      return out;
    }
    out.push(`file 1 of ${totalFiles}, ${spokenPath(first.path)}, ${LETTER_WORD[first.letter] ?? 'modified'}, ${first.added} added, ${first.deleted} removed`);
  }
  const d = describeAction(action);
  if (d.preview === '') return out;
  if (withheldPath(first?.path ?? '')) {
    out.push(WITHHELD_ROW_TEXT);
    return out;
  }
  const rows = diffRows(d.preview, { columns: 200, maxRows: REVIEW_DIFF_HARD_CAP, g: GLYPHS.sr, lineNumbers: false, fileRow: 'none', firstFileOnly: true, withhold: withheldPath });
  const changed = rows.filter((r) => r.kind === 'add' || r.kind === 'del');
  const spoken: string[] = [];
  for (let i = 0; i < changed.length && spoken.length < SR_DIFF_ROWS; i++) {
    const r = changed[i];
    if (r === undefined) continue;
    const body = r.text.slice(1);
    const next = changed[i + 1];
    // §6.10 / §14.2 review item 10: a whitespace-only change is one sentence, not two identical spoken lines. The
    // decision is `diffRows`' own `wsOnly` flag, taken from the PARSED bodies: the rendered rows already carry
    // `markTrailing`'s `·` cells, so comparing those could never find the pair this sentence exists for.
    if (r.kind === 'del' && r.wsOnly === true && next !== undefined && next.kind === 'add' && next.wsOnly === true) {
      spoken.push(`line ${r.oldNo ?? next.newNo ?? 0} changed: trailing whitespace removed`);
      i += 1;
      continue;
    }
    spoken.push(`line ${(r.kind === 'add' ? r.newNo : r.oldNo) ?? 0} ${r.kind === 'add' ? 'added' : 'removed'}: ${spokenCode(body)}`);
  }
  out.push(...spoken);
  const hidden = changed.length - spoken.length;
  if (hidden > 0) out.push(`… ${hidden} more changed lines; press 3 then diff for the full text`);
  return out;
}

/** TUI-DESIGN §6.5 / TUI-DESIGN-4 §6.10: the screen-reader review as `<Static>` lines — title, one aria row per dimension (no ruler, no bars), `matches_intent`, the spoken change, then `1 approve  2 decline  3 decline with a note` and `Enter selection (1-3):`. */
export function reviewScreenReaderLines(req: ConfirmRequest, columns = 80): string[] {
  const g = GLYPHS.sr;
  const w = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80));
  // TUI-DESIGN-5 §4.6 (D-AM): the SR twin substitutes the same way — the five dimension rows become the headline
  // rows (there are no dimensions to speak) and the spoken change becomes the pre-rendered body.
  if (isProposalConfirm(req)) {
    return [reviewTitle(req, w, g), ...(req.headline ?? []).map((l) => oneLineCells(l)), ...confirmPreviewLines(req).map((l) => oneLineCells(l)), SR_REVIEW_CHOICES, SR_REVIEW_PROMPT].map((l) => oneLineCells(l));
  }
  return [
    reviewTitle(req, w, g),
    ...RISK_DIMENSIONS.map((dim) => `${reviewDigit(dim)} ${reviewAriaLabel(req, dim)}`),
    `5 ${reviewAriaLabel(req, 'matches_intent')}`,
    ...reviewDiffScreenReaderLines(req),
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
    // TUI-DESIGN-2 §4.7: the cli-boxes `round` set (`╭ ╮ ╰ ╯`), the title in the top edge
    const top = `${g.roundTopLeft} ${FOLLOWUP_TITLE} `;
    const topLine = cellWidth(top) + 1 <= w ? `${top}${g.boxHorizontal.repeat(w - cellWidth(top) - 1)}${g.roundTopRight}` : truncateCells(`${g.roundTopLeft} ${FOLLOWUP_TITLE}`, w, g);
    const framed = (s: string): string => `${g.boxVertical} ${fitCells(s, inner, g)} ${g.boxVertical}`;
    return [topLine, framed(keys), framed(session), framed(FOLLOWUP_NOTE), `${g.roundBottomLeft}${g.boxHorizontal.repeat(w - 2)}${g.roundBottomRight}`];
  }
  const plain = [FOLLOWUP_TITLE, keys, session, FOLLOWUP_NOTE];
  return plain.slice(0, Math.min(rows, 4)).map((l) => truncateCells(l, w, g));
}
