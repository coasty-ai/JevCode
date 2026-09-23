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
import type { AgentRow } from '../../core/types.js';
import { focusedTail } from '../agents/lines.js';
import { GLYPHS, cellWidth, fitCells, ruleRow, truncateCells, type GlyphSet } from '../glyphs.js';
import { agentTabRows } from './agents.js';
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

/** TUI-DESIGN-5 §4.3 (OR §4.6 [G20]/[D7]): the fifth tab is `'a'` — the agent tree, shown only while something delegates. */
export type PaneTab = 'd' | 'p' | 't' | 's' | 'a';
/**
 * **UNCHANGED: the four production tabs.** `cycleTab`'s default binds to THIS, and that is the whole point
 * (TUI-DESIGN-5 §4.3, §14.2 #1/#31): an earlier draft widened `PANE_TABS` itself to five *and* defaulted
 * `cycleTab`'s third parameter to it, which silently changes the two-argument answers
 * (`cycleTab('s', 1)` → `'a'`, `cycleTab('d', -1)` → `'a'`) and turns `test/unit/tui/pane/model.test.ts:165–167`
 * red. Binding the default here keeps those cases green **and unedited**, which is what they are the guard for.
 */
export const PANE_TABS: readonly PaneTab[] = ['d', 'p', 't', 's'];
/** TUI-DESIGN-5 §4.3: the five-tab list, used only while something is delegating. */
export const PANE_TABS_WITH_AGENTS: readonly PaneTab[] = ['d', 'p', 't', 's', 'a'];
/** TUI-DESIGN-5 §4.3: the tab list at a moment — `PANE_TABS_WITH_AGENTS` while a child exists, the four otherwise. */
export function paneTabsFor(hasDelegation: boolean): readonly PaneTab[] {
  return hasDelegation ? PANE_TABS_WITH_AGENTS : PANE_TABS;
}

/** The modal slot above the composer (`OverlayKind` in `src/tui/layout.ts`, O3); the pane only asks whether it is `'none'` (§7.2). */
export type PaneOverlay = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm' | 'import';

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
  /** TUI-DESIGN-2 §3.11: the last intakes' `s0 intake …` rows, shown above the run's rows on the decisions tab */
  readonly chatRows?: readonly DecisionRow[];
  /** TUI-DESIGN-2 §4.6: the last risk assessment of the run (`risk 0.44 [review]` on the strip) */
  readonly lastRisk?: { risk: number; verdict: 'ok' | 'review' | 'block' } | null;
  /**
   * TUI-DESIGN-5 §4.3: the agent tree's rows. **Absent or empty is "nothing delegates"**, which is what makes the
   * `'a'` tab invisible in production until real rows exist (§4.0) — every tab-list call site reads
   * `paneTabsFor(hasDelegation(state))`, never a separate flag that could disagree with the rows.
   */
  readonly agents?: readonly AgentRow[];
  /** TUI-DESIGN-5 §4.3: the agents tab holds focus (`Alt+A`); the rule row's tail says so (S86b) so it is never invisible. */
  readonly paneFocus?: boolean;
  /**
   * TUI-DESIGN-5 §4.3 / §13.2 clause 6: the highlighted agent row, and therefore the row the tab's **viewport**
   * centres on. Without it `agentTabRows` always starts at 0 and the rows below `AGENTS_TAB_ROWS` are unreachable:
   * the marker would say `↓18 below` with no key in the build that can reach them. `UiState.agentCursor`
   * (`src/tui/useEngine.tsx`), moved by `↑`/`↓` while the tab is focused, is its source.
   */
  readonly agentCursor?: number;
}

/** TUI-DESIGN-5 §4.3: the one predicate `paneTabsFor` is called with, so the tab, the strip and `]`/`[` cannot disagree. */
export function hasDelegation(state: Pick<PaneState, 'agents'>): boolean {
  return (state.agents?.length ?? 0) > 0;
}

/** TUI-DESIGN-2 §4.6: the ONE threshold for the strip and the open header — long tab labels, the `jev <ms>ms` segment and the 5-rule tail from here. */
export const PANEL_WIDE_COLUMNS = 120;
/** TUI-DESIGN-2 §4.6 / §12 "Rule row": the 6th open row when the tab has more. */
export function panelMoreRow(n: number, g: GlyphSet = GLYPHS.unicode): string {
  return `  ${g.ellipsis} ${n} more row${n === 1 ? '' : 's'} ${g.dot} /panel full expands`;
}
/** the shortest rule fill between the strip's segments and its tab labels before a segment is dropped from the right */
const STRIP_MIN_FILL = 4;

/**
 * TUI-DESIGN §7.2: `[`/`]` cycle through d → p → t → s, and TUI-DESIGN-5 §4.3 through `d → p → t → s → a` when the
 * caller passes `paneTabsFor(true)`. The default is the **four-member** `PANE_TABS`, so the two-argument form's
 * answers are round 2's byte for byte (§14.2 #1/#31) and `]` / `[` skip `'a'` while nothing delegates.
 * A `tab` outside `tabs` (the focused `'a'` tab the moment the last agent ends) restarts at the first member.
 */
export function cycleTab(tab: PaneTab, dir: 1 | -1, tabs: readonly PaneTab[] = PANE_TABS): PaneTab {
  const list = tabs.length === 0 ? PANE_TABS : tabs;
  const i = list.indexOf(tab);
  if (i < 0) return list[dir === 1 ? 0 : list.length - 1] ?? 'd';
  return list[(i + dir + list.length) % list.length] ?? 'd';
}

/** TUI-DESIGN §7.2 (jev-native graft): in jev-only the default tab is `s` while a step's propose stage runs and `d` otherwise. */
export function defaultTab(mode: EngineMode | null | undefined, stage: StageName | 'idle' | null | undefined): PaneTab {
  return mode === 'jev-only' && stage === 'propose' ? 's' : 'd';
}

/** TUI-DESIGN §7.2 side-by-side rule: only when `columns ≥ 120 && rows ≥ 40 && overlay === 'none'`. */
export function sideBySide(rows: number, columns: number, overlay: PaneOverlay): boolean {
  return columns >= 120 && rows >= 40 && overlay === 'none';
}

/** TUI-DESIGN-5 §4.3: total over `PaneTab` — TypeScript's exhaustiveness check finds a new tab here for free. */
export const TAB_TITLE: Readonly<Record<PaneTab, string>> = { d: 'decisions', p: 'plan', t: 'timeline', s: 'synth', a: 'agents' };

/**
 * TUI-DESIGN-5 §4.3 / §12.3 S86: the **one** tab-strip builder. Round 2 wrote the strip as two literal strings
 * (`paneRuleRow`'s ` [d]ecisions [p]lan [t]ime [s]ynth ` and `panelStrip`'s ` [d] [p] [t] [s] `); F-54's earlier
 * `d p t s [a]` form was a *second* grammar (§14.2 #31), so round 5 keeps the landed one and appends one segment
 * while delegating. `long` is the wide form (`[d]ecisions`), the narrow one is the bracketed letter alone.
 * `[t]imeline` shortens to `[t]ime` below `PANELE_WIDE` in the rule row only — `wide` says which.
 */
export function tabStrip(tabs: readonly PaneTab[], form: 'long' | 'short', wide: boolean): string {
  const label = (t: PaneTab): string => {
    if (form === 'short') return `[${t}]`;
    const title = TAB_TITLE[t];
    const shown = t === 't' && !wide ? 'time' : title;
    return `[${t}]${shown.slice(1)}`;
  };
  return tabs.map(label).join(' ');
}

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
    case 'a': {
      // TUI-DESIGN-5 §4.3: the label is the tally, so the rule row carries the fact even when the tab is one row tall
      const n = state.agents?.length ?? 0;
      return n === 0 ? `agents ${s}` : `agents ${s} ${g.dot} ${n} agent${n === 1 ? '' : 's'}`;
    }
  }
}

/** Geometry the side-by-side rule and the glyph set the pane draws with (§7.2: the rule reads the terminal's rows, not the pane's row budget). */
export interface PaneOptions {
  /** the terminal height (`useWindowSize().rows`); defaults to the pane's `rows` argument, which can never reach 40 on its own */
  terminalRows?: number;
  glyphs?: GlyphSet;
  /** TUI-DESIGN-2 §4.6: the open / full panel's header leads with `▾ ` before the tab name */
  chevron?: boolean;
  /**
   * TUI-DESIGN-4 §1.2 P-H1 edge 5: the open / full panel's tab header takes the **same** `◆ jevcode` prefix through the
   * same helper and the same drop order — it is the rule row in that state, so the brand must not vanish when a panel
   * opens. Dropped first when the header runs out of width (`STRIP_MIN_FILL`), exactly as on the strip.
   */
  brand?: boolean;
}

/** §1.2 P-H1: the brand segment and the one rule cell that separates it from the pane information (`* jevcode -` under `--ascii`). */
export function brandSegment(g: GlyphSet = GLYPHS.unicode): string {
  return `${g.brand} jevcode ${g.rule} `;
}

/** §1.2 P-H1: `brand + left` when the row still keeps `STRIP_MIN_FILL` rule cells between the two halves, else `left` — the brand is dropped first. */
function brandFits(left: string, right: string, columns: number, g: GlyphSet): boolean {
  return Math.min(Math.max(0, Math.floor(columns)), 400) - cellWidth(`${g.rule.repeat(3)} ${brandSegment(g)}${left} `) - cellWidth(right) >= STRIP_MIN_FILL;
}

/** TUI-DESIGN §7.2 / §24 / TUI-DESIGN-2 §4.6: the pane's rule row — `─── [▾ ]decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──` (`[t]imeline` and the 5-rule tail from `PANEL_WIDE_COLUMNS`; the second tab's name appended when side by side). */
export function paneRuleRow(state: PaneState, rows: number, columns: number, overlay: PaneOverlay, opts: PaneOptions = {}): string {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const wide = columns >= PANEL_WIDE_COLUMNS;
  // TUI-DESIGN-5 §4.3 / §12.3 S86: computed from `paneTabsFor(...)`, so the landed grammar gains exactly one
  // segment while delegating (`[a]gents`) and is byte-for-byte round 4's otherwise.
  const list = paneTabsFor(hasDelegation(state));
  // §4.3: the focused strip says so, so the state is never invisible (S86b)
  const focus = state.paneFocus === true && state.tab === 'a' ? `${g.rule.repeat(2)} ${focusedTail(g)} ${g.rule}` : '';
  const label = `${opts.chevron === true ? `${g.chevronDown} ` : ''}${paneRuleLabel(state, columns, g)}`;
  const rightWith = (form: 'long' | 'short'): string => {
    const tabs = ` ${tabStrip(list, form, wide)} `;
    if (focus !== '') return `${tabs}${focus}`;
    return sideBySide(opts.terminalRows ?? rows, columns, overlay) ? `${tabs}${g.rule.repeat(3)} ${TAB_TITLE[cycleTab(state.tab, 1, list)]} ${g.rule}` : `${tabs}${g.rule.repeat(wide ? 5 : 2)}`;
  };
  /**
   * §4.12: the strip's own TEXT shortens before the strip is dropped. `ruleRow` drops the right segment whole when
   * it does not fit, so the fifth `[a]gents` segment would have taken the whole tab list off an 80-column rule row
   * — the one row that tells the user the tab exists. The short form is tried first, and only then is the drop
   * `ruleRow`'s.
   *
   * **The fallback is gated on the fifth segment existing.** Applied unconditionally it also rewrites round 4's
   * non-delegating rule row at every width below ~54 columns (`─── decisions s7 ──── [d] [p] [t] [s] ──` where
   * round 4 dropped the right segment whole), which is a change nothing in round 5 asked for and no test pinned.
   * With nothing delegating this row is byte-for-byte round 4's, and `pane/model.test.ts` asserts that at 40.
   */
  const long = rightWith('long');
  const room = Math.min(Math.max(0, Math.floor(columns)), 400) - cellWidth(`${g.rule.repeat(3)} ${label} `);
  const right = list.length > PANE_TABS.length && cellWidth(long) > room ? rightWith('short') : long;
  // §1.2 P-H1 edge 5: the same prefix, the same drop order — the brand goes first when the header runs out of width
  const branded = opts.brand === true && brandFits(label, right, columns, g);
  return ruleRow(branded ? `${brandSegment(g)}${label}` : label, right, columns, g);
}

/** TUI-DESIGN-2 §4.6: `plan <done>/<done + remaining>` of the plan tab's view, or null without a plan. */
export function planProgress(state: PaneState): { done: number; total: number } | null {
  const plan = state.plan?.plan;
  if (!plan) return null;
  return { done: plan.done.length, total: plan.done.length + plan.remaining.length };
}

/** TUI-DESIGN-4 §1.2 P-H1 / §1.3.2: the two optional strip members round 4 adds. Absent = round 2's strip, byte for byte. */
export interface StripOptions {
  /**
   * P-H1 (D-T a): prepend the permanent `◆ jevcode` brand segment (`* jevcode` under `--ascii`), separated from the pane
   * information by one rule cell. It is the **first** segment dropped when the strip runs out of width, so a 40-column
   * strip is byte-for-byte the brandless one. Drawn whether or not the 5-row mark is up (F-H1, F-H2; TD3 §729).
   */
  brand?: boolean;
  /**
   * §1.3.2: the fullscreen position ladder, widest rung first (`1 240/3 512 · 35 % · PgUp` → `35 % · PgUp` → `35 %`).
   * It **replaces** the tab labels as the strip's right segment and degrades rung by rung, then drops — after the brand
   * and before any pane information. Absent (classic) = today's `[d] [p] [t] [s]` tail.
   */
  position?: readonly string[];
}

/**
 * TUI-DESIGN-2 §4.6 / §12 "Rule row", amended by TUI-DESIGN-4 §1.2 P-H1 and §1.3.2: the collapsed panel's strip on the
 * rule row — `─── [◆ jevcode ─ ]▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5[ · jev 231ms] ─── [d] [p] [t] [s] ──`
 * (long labels `[d]ecisions [p]lan [t]imeline [s]ynth`, the `jev <ms>ms` segment and the 5-rule tail from
 * `PANEL_WIDE_COLUMNS`); with no decisions yet `─── ▸ jev · no decisions yet ──── [d] [p] [t] [s] ──`.
 * Exactly `min(columns, 400)` cells.
 *
 * Drop order when fewer than four rule cells would separate the left from the right (`STRIP_MIN_FILL`):
 * **the brand first**, then the position rungs (widest → narrowest → dropped), then pane segments from the right.
 * With neither option the loop is round 2's `while (segments.length > 1)` verbatim.
 */
export function panelStrip(state: PaneState & { latencies: readonly (number | null)[] }, columns: number, g: GlyphSet = GLYPHS.unicode, opts: StripOptions = {}): string {
  const wide = columns >= PANEL_WIDE_COLUMNS;
  /**
   * OWNER ADDENDUM (2026-09): the collapsed strip is a QUIET status row. The hotkey legend
   * `[d]ecisions [p]lan [t]imeline [s]ynth` is gone from it — the keys still work and the legend lives in `?` help and
   * in the palette; a row the user reads once a second must not shout four shortcuts at them. The legend stays on the
   * OPEN / FULL panel's own tab header (`paneRuleRow`), where it names what the visible tabs are. The fullscreen
   * renderer's position ladder still replaces the right segment when it is given one.
   */
  const rungs = opts.position ?? null;
  const tabs = g.rule.repeat(wide ? 5 : 2);
  const rows = [...(state.chatRows ?? []), ...state.rows];
  const segments: string[] =
    rows.length === 0
      ? [`${g.chevronRight} jev ${g.dot} no decisions yet`]
      : [`${g.chevronRight} jev s${state.step}`, `${rows.length} decision${rows.length === 1 ? '' : 's'}`];
  if (rows.length > 0) {
    const risk = state.lastRisk ?? null;
    if (risk !== null) segments.push(`risk ${p2(risk.risk)} ${risk.verdict === 'ok' ? 'ok' : `[${risk.verdict}]`}`);
    const plan = planProgress(state);
    if (plan !== null) segments.push(`plan ${plan.done}/${plan.total}`);
    const last = state.latencies.length > 0 ? state.latencies[state.latencies.length - 1] : null;
    if (wide && last !== null && last !== undefined && Number.isFinite(last)) segments.push(`jev ${Math.round(last)}ms`);
  }
  const w = Math.min(Math.max(0, Math.floor(columns)), 400);
  let brand = opts.brand === true;
  let rung = 0;
  const brandText = brandSegment(g);
  const rightOf = (): string => (rungs === null ? tabs : rung < rungs.length ? ` ${rungs[rung] ?? ''} ${g.rule.repeat(2)}` : g.rule.repeat(2));
  const leftOf = (): string => `${brand ? brandText : ''}${segments.join(` ${g.dot} `)}`;
  for (;;) {
    const fill = w - cellWidth(`${g.rule.repeat(3)} ${leftOf()} `) - cellWidth(rightOf());
    if (fill >= STRIP_MIN_FILL) break;
    if (brand) brand = false;
    else if (rungs !== null && rung < rungs.length) rung += 1;
    else if (segments.length > 1) segments.pop();
    else break;
  }
  return ruleRow(leftOf(), rightOf(), columns, g);
}

function p2(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : 'nan';
}

/** the decisions tab's rows with the intakes' rows (TUI-DESIGN-2 §3.11) ahead of the run's */
function withChatRows(state: PaneState): PaneState {
  const chat = state.chatRows ?? [];
  return chat.length === 0 ? state : { ...state, rows: [...chat, ...state.rows] };
}

/**
 * TUI-DESIGN-2 §4.6 `panelLines`: the open panel's rows (≤ 6, `CAP.panel`) or the full pane (`paneLines`). Open: the
 * decisions tab shows the newest rows (the last intake's `s0 intake` row pinned first when present); when the tab has
 * more rows than fit, the last row is `  … <n> more rows · /panel full expands`. Never more than `rows` rows nor wider
 * than `columns`.
 */
export function panelLines(state: PaneState, rows: number, columns: number, overlay: PaneOverlay, opts: PaneOptions & { size: 'open' | 'full' }): string[] {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  const w = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  if (n === 0 || w === 0) return [];
  const full = withChatRows(state);
  if (opts.size === 'full') return paneLines(full, n, w, overlay, opts);
  if (state.tab === 'd') {
    const chat = state.chatRows ?? [];
    const pinned = chat.length > 0 ? [chat[chat.length - 1] as DecisionRow] : [];
    const total = pinned.length + state.rows.length;
    if (total <= n) return decisionRows({ ...state, rows: [...pinned, ...state.rows] }, n, w, g);
    const shown = Math.max(0, n - 1);
    const runRows = state.rows.slice(-(Math.max(0, shown - pinned.length)));
    const lines = shown > 0 ? decisionRows({ ...state, rows: [...pinned, ...runRows] }, shown, w, g) : [];
    return [...lines, truncateCells(panelMoreRow(total - shown, g), w, g)];
  }
  const all = tabLines(full, state.tab, 200, w, g);
  if (all.length <= n) return all.slice(0, n).map((l) => truncateCells(l, w, g));
  const shown = Math.max(0, n - 1);
  return [...all.slice(0, shown).map((l) => truncateCells(l, w, g)), truncateCells(panelMoreRow(all.length - shown, g), w, g)];
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
    case 'a':
      // TUI-DESIGN-5 §13.2 clause 6: the viewport centres on the highlighted row, which is what makes rows 13+
      // of a 30-row tree reachable at all (`↑`/`↓` move `UiState.agentCursor`, §4.3)
      return agentTabRows(state, rows, columns, g, state.agentCursor === undefined ? {} : { cursor: state.agentCursor });
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
  const right = sideTabLines(state, cycleTab(state.tab, 1, paneTabsFor(hasDelegation(state))), n, rightCells, g);
  const out: string[] = [];
  for (let i = 0; i < n && (i < left.length || i < right.length); i++) {
    const r = right[i] ?? '';
    out.push(truncateCells(`${fitCells(left[i] ?? '', SIDE_LEFT_CELLS, g)}${g.vbar}${r ? ` ${truncateCells(r, rightCells, g)}` : ''}`, w, g));
  }
  return out;
}
