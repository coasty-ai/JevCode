/**
 * Jev-native pane model (TUI-DESIGN §7.1, jev-native graft): `DecisionRow` = one `Decision` plus
 * the code rule that consumed the answer and the near-threshold flag; the timeline fold; the
 * `PaneState` the tab builders read; and the pane's composition (`paneLines`, `paneRuleRow`,
 * §7.2 side-by-side rule). Pure over `Decision`; no I/O, no clock.
 */
import { DEFAULT_COMPLETE_THRESHOLD, DEFAULT_IMPOSSIBLE_THRESHOLD } from '../../config/defaults.js';
import { RISK_DIMENSIONS, type Decision, type DecisionVerdict, type EngineMode, type Json, type Plan, type StageName, type StepRecord } from '../../core/types.js';
import { riskFromProbabilities } from '../../jev/confidence.js';
import { PAIRED_PREFIX } from '../../jev/questions.js';
import { clip } from '../../core/text.js';
import { PAIRED_NOUL_FLOOR } from '../../loop/stages/choose.js';
import { PLAN_ACCEPT_THRESHOLD, PLAN_REJECT_THRESHOLD } from '../../loop/plan.js';
import { GLYPHS, fitCells, ruleRow, truncateCells, type GlyphSet } from '../glyphs.js';
import { decisionRows } from './decisions.js';
import { planRows, planSummaryRow } from './plan.js';
import { synthRows } from './synth.js';
import { timelineRows } from './timeline.js';

// ---------------------------------------------------------------------------------------
// §7.1 DecisionRow
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §7.1: `!` before `p` when the consumed quantity sits within this of its rule's threshold (11 §4i). */
export const NEAR_THRESHOLD_DELTA = 0.03;
/** The band thresholds the risk rule reads (DESIGN §6 risk policy). */
export const RISK_REVIEW_THRESHOLD = 0.3;
export const RISK_BLOCK_THRESHOLD = 0.7;
/** `plan_still_valid` below this adds a `stale_plan` harness problem (DESIGN §6). */
export const STALE_PLAN_THRESHOLD = 0.3;
/** Context Nouls select a file at or above this (DESIGN §6). */
export const CONTEXT_SELECT_THRESHOLD = 0.5;
/** `matches_intent` / `evidence_consistent` below this are appended to the risk reason (risk.ts). */
export const MATCHES_INTENT_REASON_THRESHOLD = 0.3;
/** `new_information` at or above this is Plan rule (b) (DESIGN §6). */
export const NEW_INFORMATION_THRESHOLD = 0.7;

export interface DecisionRow {
  step: number;
  stage: StageName;
  id: string;
  kind: 'noul' | 'choice' | 'score';
  /** choice → answer.choice; score → `L${level}`; noul → 'noul' */
  label: string;
  /** Decision.probability */
  p: number;
  /** Decision.confidence */
  c: number;
  /** derived = noul (|2p − 1|) */
  cDerived: boolean;
  verdict: DecisionVerdict | undefined;
  latencyMs: number;
  requestHash: string;
  servedModel?: string;
  /** the code rule that read the answer (DESIGN §6 "Consumers of every Jev answer") */
  consumedBy: string;
  /** |q − threshold| ≤ 0.03 for the rule's threshold, q = the consumed quantity (p, or the dimension's risk for `risk.<dim>`) → `!` before p */
  near: { threshold: number; delta: number } | null;
  /** criteria text of the chosen option/level (≤ 300) for the 120-column column and /why */
  text: string;
}

export interface DecisionThresholds {
  completeThreshold: number;
  impossibleThreshold: number;
}

/** A consumer rule: its wording and the thresholds the `!` flag is measured against, over the consumed quantity. */
export interface ConsumerRule {
  text: string;
  thresholds: readonly number[];
  /** the quantity the rule reads: the answer probability (default) or, for `risk.<dim>`, the dimension's risk */
  quantity: number;
}

function fmtThreshold(t: number): string {
  return Number.isFinite(t) ? String(Number(t.toFixed(4))) : 'nan';
}

const HARM_DIMENSIONS: ReadonlySet<string> = new Set(['destructive', 'irreversible']);

/** DESIGN §6 / risk.ts: harm dimensions bound by max(expected, tail); alignment dimensions by the tail only. */
export function riskDimensionMode(id: string): 'harm' | 'alignment' {
  return HARM_DIMENSIONS.has(id) ? 'harm' : 'alignment';
}

/** TUI-DESIGN §7.1 `consumedBy` table: the code rule that read this answer, with the threshold(s) its `!` flag is measured against; `g` draws `→` / `≥` (the row stores the unicode form and `decisionRowText` re-renders it through `glyphTwin`). */
export function consumerRule(d: Decision, thresholds: Partial<DecisionThresholds> = {}, g: GlyphSet = GLYPHS.unicode): ConsumerRule {
  const completeT = thresholds.completeThreshold ?? DEFAULT_COMPLETE_THRESHOLD;
  const impossibleT = thresholds.impossibleThreshold ?? DEFAULT_IMPOSSIBLE_THRESHOLD;
  const p = d.probability;
  const id = d.id;
  const choice = d.answer.type === 'choice' ? d.answer.choice : null;
  const { arrow, ge } = g;
  if (d.stage === 'intent' && id === 'intent') return { text: `choice resolution ${arrow} intent ${choice ?? 'none_of_these'}`, thresholds: [], quantity: p };
  if (id.startsWith(PAIRED_PREFIX)) return { text: `paired ${ge} ${fmtThreshold(PAIRED_NOUL_FLOOR)}`, thresholds: [PAIRED_NOUL_FLOOR], quantity: p };
  if (id === 'plan_still_valid') return { text: `< ${fmtThreshold(STALE_PLAN_THRESHOLD)} ${arrow} stale_plan`, thresholds: [STALE_PLAN_THRESHOLD], quantity: p };
  if (d.stage === 'context') return { text: `selected iff p ${ge} ${fmtThreshold(CONTEXT_SELECT_THRESHOLD)}`, thresholds: [CONTEXT_SELECT_THRESHOLD], quantity: p };
  if (d.stage === 'risk' && (RISK_DIMENSIONS as readonly string[]).includes(id)) {
    const probs = d.answer.type === 'score' ? d.answer.probabilities : {};
    const n = d.question.type === 'score' ? Math.max(2, d.question.criteria.length) : 5;
    const dist = riskFromProbabilities(probs, n, undefined, riskDimensionMode(id));
    return { text: `band ${fmtThreshold(RISK_REVIEW_THRESHOLD)}/${fmtThreshold(RISK_BLOCK_THRESHOLD)} (${dist.bound})`, thresholds: [RISK_REVIEW_THRESHOLD, RISK_BLOCK_THRESHOLD], quantity: dist.risk };
  }
  if (id === 'matches_intent' || id === 'evidence_consistent') return { text: `< ${fmtThreshold(MATCHES_INTENT_REASON_THRESHOLD)} ${arrow} appended to the reason`, thresholds: [MATCHES_INTENT_REASON_THRESHOLD], quantity: p };
  if (id === 'new_information') return { text: `${ge} ${fmtThreshold(NEW_INFORMATION_THRESHOLD)} ${arrow} Plan rule b`, thresholds: [NEW_INFORMATION_THRESHOLD], quantity: p };
  if (/^done_\d+$/.test(id)) return { text: `${ge} ${fmtThreshold(PLAN_ACCEPT_THRESHOLD)} accept, < ${fmtThreshold(PLAN_REJECT_THRESHOLD)} reject`, thresholds: [PLAN_ACCEPT_THRESHOLD, PLAN_REJECT_THRESHOLD], quantity: p };
  if (id === 'task_complete') return { text: `${ge} ${fmtThreshold(completeT)} ${arrow} stop`, thresholds: [completeT], quantity: p };
  if (d.stage === 'replan' && id === 'next_move') return { text: `choice resolution ${arrow} move`, thresholds: [], quantity: p };
  if (id === 'task_impossible') return { text: `${ge} ${fmtThreshold(impossibleT)} ${arrow} stop`, thresholds: [impossibleT], quantity: p };
  return { text: 'reported', thresholds: [], quantity: p };
}

/** TUI-DESIGN §7.1: the nearest threshold within NEAR_THRESHOLD_DELTA of the consumed quantity, or null. */
export function nearThreshold(quantity: number, thresholds: readonly number[]): { threshold: number; delta: number } | null {
  if (!Number.isFinite(quantity)) return null;
  let best: { threshold: number; delta: number } | null = null;
  for (const t of thresholds) {
    const delta = Math.abs(quantity - t);
    if (delta <= NEAR_THRESHOLD_DELTA + 1e-12 && (best === null || delta < best.delta)) best = { threshold: t, delta };
  }
  return best;
}

/** One line of text for a criteria value: strings as-is, `{ definition }` objects by their definition, anything else as compact JSON. */
export function criteriaText(v: Json | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const def = v['definition'];
    if (typeof def === 'string') return def;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** TUI-DESIGN §7.1 `text`: the criteria text of the chosen option / level (a Noul: the definition of the side its p favours), ≤ 300 chars. */
export function decisionText(d: Decision): string {
  const q = d.question;
  const a = d.answer;
  let raw = '';
  if (q.type === 'choice' && a.type === 'choice') raw = criteriaText(q.criteria[a.choice]);
  else if (q.type === 'score' && a.type === 'score') raw = criteriaText(q.criteria[a.score]);
  else if (q.type === 'noul') raw = criteriaText(a.type === 'noul' && a.noul < 0.5 ? q.criteria?.false : q.criteria?.true);
  return clip(raw.replace(/\s+/g, ' ').trim(), 300);
}

/** TUI-DESIGN §7.1 `label`: choice → the raw choice; score → `L<level>`; noul → `noul`. */
export function decisionLabel(d: Decision): string {
  switch (d.answer.type) {
    case 'choice':
      return d.answer.choice;
    case 'score':
      return `L${d.answer.score}`;
    case 'noul':
      return 'noul';
  }
}

/** TUI-DESIGN §7.1 `toDecisionRow(d, completeThreshold)`: the pane row with `consumedBy` and `near` for a `Decision`. */
export function toDecisionRow(d: Decision, completeThreshold: number = DEFAULT_COMPLETE_THRESHOLD, impossibleThreshold: number = DEFAULT_IMPOSSIBLE_THRESHOLD): DecisionRow {
  const rule = consumerRule(d, { completeThreshold, impossibleThreshold });
  return {
    step: d.step,
    stage: d.stage,
    id: d.id,
    kind: d.answer.type,
    label: decisionLabel(d),
    p: d.probability,
    c: d.confidence,
    cDerived: d.answer.type === 'noul',
    verdict: d.verdict,
    latencyMs: d.latencyMs,
    requestHash: d.requestHash,
    ...(d.servedModel !== undefined ? { servedModel: d.servedModel } : {}),
    consumedBy: rule.text,
    near: nearThreshold(rule.quantity, rule.thresholds),
    text: decisionText(d),
  };
}

/** TUI-DESIGN §7.1: the `byStep` map the reducer keeps (rows of the last `keepSteps` steps) folded from a new row. */
export function foldByStep(byStep: ReadonlyMap<number, readonly DecisionRow[]>, row: DecisionRow, keepSteps = 3): Map<number, DecisionRow[]> {
  const next = new Map<number, DecisionRow[]>();
  for (const [step, rows] of byStep) next.set(step, [...rows]);
  next.set(row.step, [...(next.get(row.step) ?? []), row]);
  const steps = [...next.keys()].sort((a, b) => b - a);
  for (const s of steps.slice(Math.max(0, keepSteps))) next.delete(s);
  return next;
}

// ---------------------------------------------------------------------------------------
// §7.2 timeline fold
// ---------------------------------------------------------------------------------------

/** One step of the `t` tab: per-stage ms from `stage:end`, totals from `step:end.record` (§7.2 "Data" column). */
export interface TimelineStep {
  step: number;
  stages: Partial<Record<StageName, number>>;
  /** record.timing.totalMs once the step committed; null while live */
  totalMs: number | null;
  harnessMs: number | null;
  generatorTokens: number | null;
  generatorUsd: number | null;
}

/** Steps kept for the timeline (the 120-column form shows up to 30 letters per row; 12 rows at most are visible). */
export const TIMELINE_STEPS_KEPT = 30;

/** TUI-DESIGN §7.2 `t` data: fold one `stage:end` into the timeline (newest step first, ≤ TIMELINE_STEPS_KEPT). */
export function foldStageEnd(steps: readonly TimelineStep[], e: { step: number; stage: StageName; ms: number }, keep = TIMELINE_STEPS_KEPT): TimelineStep[] {
  const ms = Number.isFinite(e.ms) && e.ms >= 0 ? e.ms : 0;
  const idx = steps.findIndex((s) => s.step === e.step);
  if (idx === -1) {
    const fresh: TimelineStep = { step: e.step, stages: { [e.stage]: ms }, totalMs: null, harnessMs: null, generatorTokens: null, generatorUsd: null };
    return [fresh, ...steps].sort((a, b) => b.step - a.step).slice(0, Math.max(0, keep));
  }
  const cur = steps[idx]!;
  const updated: TimelineStep = { ...cur, stages: { ...cur.stages, [e.stage]: (cur.stages[e.stage] ?? 0) + ms } };
  return steps.map((s, i) => (i === idx ? updated : s));
}

/** TUI-DESIGN §7.2 `t` data: fold a committed `step:end.record` (timing and generator usage) into the timeline. */
export function foldStepEnd(steps: readonly TimelineStep[], record: Pick<StepRecord, 'step' | 'timing' | 'usage'>, keep = TIMELINE_STEPS_KEPT): TimelineStep[] {
  const gen = record.usage.generator;
  const base: TimelineStep = steps.find((s) => s.step === record.step) ?? { step: record.step, stages: {}, totalMs: null, harnessMs: null, generatorTokens: null, generatorUsd: null };
  const updated: TimelineStep = {
    ...base,
    totalMs: Number.isFinite(record.timing.totalMs) ? record.timing.totalMs : null,
    harnessMs: Number.isFinite(record.timing.harnessMs) ? record.timing.harnessMs : null,
    generatorTokens: gen.inputTokens + gen.outputTokens,
    generatorUsd: gen.costUsd,
  };
  const rest = steps.filter((s) => s.step !== record.step);
  return [updated, ...rest].sort((a, b) => b.step - a.step).slice(0, Math.max(0, keep));
}

// ---------------------------------------------------------------------------------------
// §7.2 pane state and composition
// ---------------------------------------------------------------------------------------

export type PaneTab = 'd' | 'p' | 't' | 's';
export const PANE_TABS: readonly PaneTab[] = ['d', 'p', 't', 's'];

/** The modal slot above the composer (`OverlayKind` in `src/tui/layout.ts`, O3); the pane only asks whether it is `'none'` (§7.2). */
export type PaneOverlay = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm';

/** The last `plan` event plus what the plan tab's `done_<j>` and 120-column evidence column need (§7.2 `p` row). */
export interface PlanView {
  step: number;
  plan: Plan;
  /** parsed test counts by step (from `step:end.record.judge.tests`), for `evidence tests 41p/0f/0e` */
  testsByStep?: ReadonlyMap<number, { passed: number; failed: number; errors: number }>;
  /** the claims judged at each step in `done_<j>` order (`step:end.record.judge.doneClaims[].text`), so the ledger's `done_<j>` is the engine's own id (`src/loop/plan.ts`: `done_${claims.indexOf(text)}`); a step without an entry prints the probability alone */
  claimsByStep?: ReadonlyMap<number, readonly string[]>;
}

/** TUI-DESIGN §7.2 `p` data: fold a committed `step:end.record.judge` into the plan view's evidence maps (parsed test counts, the step's claims in `done_<j>` order); the `plan` event of the same step precedes the record (engine.ts), so the view exists. */
export function foldPlanRecord(view: PlanView, record: Pick<StepRecord, 'step' | 'judge'>): PlanView {
  const judge = record.judge;
  if (!judge) return view;
  const tests = new Map(view.testsByStep ?? []);
  const claims = new Map(view.claimsByStep ?? []);
  if (judge.tests && judge.tests.source === 'parsed') tests.set(record.step, { passed: judge.tests.passed, failed: judge.tests.failed, errors: judge.tests.errors });
  if (judge.doneClaims.length > 0) claims.set(record.step, judge.doneClaims.map((c) => c.text));
  return { ...view, testsByStep: tests, claimsByStep: claims };
}

/** The last `synth` event (§7.2 `s` row; free text until the structured fields land, A48). */
export interface SynthView {
  step: number;
  phase: string;
  detail: string;
  candidates?: number;
  tested?: number;
}

/** What every tab's `lines(state, rows, columns, overlay)` reads (a structural subset of `UiState` 1.1, §15 item 20). */
export interface PaneState {
  readonly tab: PaneTab;
  /** the current step for the rule row (`s7`) */
  readonly step: number;
  readonly rows: readonly DecisionRow[];
  readonly plan: PlanView | null;
  readonly timeline: readonly TimelineStep[];
  readonly synth: SynthView | null;
  readonly mode?: EngineMode | null;
}

/** TUI-DESIGN §7.2: `[`/`]` cycle through d → p → t → s. */
export function cycleTab(tab: PaneTab, dir: 1 | -1): PaneTab {
  const i = PANE_TABS.indexOf(tab);
  return PANE_TABS[(i + dir + PANE_TABS.length) % PANE_TABS.length] ?? 'd';
}

/** TUI-DESIGN §7.2 (jev-native graft): in jev-only the default tab is `s` while a step's propose stage runs and `d` otherwise. */
export function defaultTab(mode: EngineMode | null | undefined, stage: StageName | 'idle' | null | undefined): PaneTab {
  return mode === 'jev-only' && stage === 'propose' ? 's' : 'd';
}

/** TUI-DESIGN §7.2 side-by-side rule: only when `columns ≥ 120 && rows ≥ 40 && overlay === 'none'`. */
export function sideBySide(rows: number, columns: number, overlay: PaneOverlay): boolean {
  return columns >= 120 && rows >= 40 && overlay === 'none';
}

const TAB_TITLE: Record<PaneTab, string> = { d: 'decisions', p: 'plan', t: 'timeline', s: 'synth' };

/** The rule row's left label per tab (§24 "Rule row"). */
export function paneRuleLabel(state: PaneState, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const s = `s${state.step}`;
  switch (state.tab) {
    case 'd':
      return columns >= 80 ? `decisions ${s} ${g.dot} c~ derived |2p${g.minus}1|` : `decisions ${s}`;
    case 'p': {
      const plan = state.plan?.plan;
      if (!plan) return `plan ${s}`;
      return `plan ${s} ${g.dot} done ${plan.done.length} rem ${plan.remaining.length} unv ${plan.unverified.length} prob ${plan.harnessProblems.length}`;
    }
    case 't':
      return `timeline ${s}`;
    case 's':
      return `synth ${s}`;
  }
}

/** Geometry the side-by-side rule and the glyph set the pane draws with (§7.2: the rule reads the terminal's rows, not the pane's row budget). */
export interface PaneOptions {
  /** the terminal height (`useWindowSize().rows`); defaults to the pane's `rows` argument, which can never reach 40 on its own */
  terminalRows?: number;
  glyphs?: GlyphSet;
}

/** TUI-DESIGN §7.2 / §24: the pane's rule row — `─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──` (`[t]imeline` at ≥ 120; the second tab's name appended when side by side). */
export function paneRuleRow(state: PaneState, rows: number, columns: number, overlay: PaneOverlay, opts: PaneOptions = {}): string {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const wide = columns >= 120;
  const tabs = ` [d]ecisions [p]lan ${wide ? '[t]imeline' : '[t]ime'} [s]ynth `;
  const right = sideBySide(opts.terminalRows ?? rows, columns, overlay) ? `${tabs}${g.rule.repeat(3)} ${TAB_TITLE[cycleTab(state.tab, 1)]} ${g.rule}` : `${tabs}${g.rule.repeat(wide ? 5 : 2)}`;
  return ruleRow(paneRuleLabel(state, columns, g), right, columns, g);
}

/** One tab's rows in the wide (one tab) or narrow (half) form. */
export function tabLines(state: PaneState, tab: PaneTab, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  switch (tab) {
    case 'd':
      return decisionRows(state, rows, columns, g);
    case 'p':
      return planRows(state, rows, columns, g);
    case 't':
      return timelineRows(state, rows, columns, g);
    case 's':
      return synthRows(state, rows, columns, g);
  }
}

/** Left half width of the side-by-side form (59 + 1 divider + 60 = 120, §7.2). */
export const SIDE_LEFT_CELLS = 59;
/** Right half width: a leading space and 59 cells of the narrow form (F-D `│ [x] …`). */
export const SIDE_RIGHT_CELLS = 60;

/** TUI-DESIGN §7.2 / F-D: the second tab's rows for the right half — the plan tab is headed by its summary row (`plan  done 2  remaining 3  unverified 1  problems 1`, whose numbers otherwise live only on the rule row of the active tab). */
export function sideTabLines(state: PaneState, tab: PaneTab, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  if (tab === 'p' && state.plan && rows > 0) return [truncateCells(planSummaryRow(state.plan.plan), columns, g), ...planRows(state, rows - 1, columns, g)];
  return tabLines(state, tab, rows, columns, g);
}

/**
 * TUI-DESIGN §7.2 `lines(state, rows, columns, overlay)`: the pane's rows — the active tab alone, or the
 * active tab and the next one side by side under the side-by-side rule (`opts.terminalRows` is the
 * terminal height): 59 cells of the active tab, the divider, then a space and 59 cells of the next tab,
 * both in the narrow row form whatever the terminal width (the design fixes the halves at 59 + 1 + 60;
 * columns beyond 120 stay blank). Never more than `rows` rows nor wider than `columns`.
 */
export function paneLines(state: PaneState, rows: number, columns: number, overlay: PaneOverlay = 'none', opts: PaneOptions = {}): string[] {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  const w = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  if (n === 0 || w === 0) return [];
  if (!sideBySide(opts.terminalRows ?? n, w, overlay)) return tabLines(state, state.tab, n, w, g).slice(0, n).map((l) => truncateCells(l, w, g));
  const rightCells = SIDE_RIGHT_CELLS - 1;
  const left = tabLines(state, state.tab, n, SIDE_LEFT_CELLS, g);
  const right = sideTabLines(state, cycleTab(state.tab, 1), n, rightCells, g);
  const out: string[] = [];
  for (let i = 0; i < n && (i < left.length || i < right.length); i++) {
    const r = right[i] ?? '';
    out.push(truncateCells(`${fitCells(left[i] ?? '', SIDE_LEFT_CELLS, g)}${g.vbar}${r ? ` ${truncateCells(r, rightCells, g)}` : ''}`, w, g));
  }
  return out;
}
