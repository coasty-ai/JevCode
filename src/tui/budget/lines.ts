/**
 * Money lines (TUI-DESIGN §9, §24): the pure text behind every budget surface — the 50/80/95 % threshold detector
 * with its `restored` semantics (§9.2), the `[run] budget: …` items (§9.2, §9.4), the follow-up `y/r/n` box and the
 * session-cap refusal (§9.3), the meter words and status meters (§9.6, §24), `/cost` (§9.6) and the spend-cap
 * epilogue (§9.4). Shared by the Ink, `--plain` and screen-reader twins so parity is a unit test; no I/O, no clock.
 */
import type { EngineEvent, EngineMode } from '../../core/types.js';

export type BudgetPct = 50 | 80 | 95;
/** TUI-DESIGN §9.2 (A131, C51): the three announced thresholds, ascending. */
export const BUDGET_THRESHOLDS: readonly BudgetPct[] = [50, 80, 95];

/** TUI-DESIGN §24 meter words. */
export type MeterWord = 'ok' | 'half' | 'high' | 'critical' | 'over' | 'uncapped';

export type BudgetEvent = Extract<EngineEvent, { type: 'budget:warn' | 'budget:stop' | 'budget:clamp' | 'budget:override' | 'budget:unpriced' }>;
/**
 * TUI-DESIGN §9.2: the run `budget:warn` with the recent per-step cost the engine measured (`perStepUsd`, an additive
 * event field requested from O1 — structural here so the renderers compile either way). Without it the item ends at
 * `about N steps left`: the rate is never back-derived from the floored estimate.
 */
export type BudgetWarnEvent = Extract<BudgetEvent, { type: 'budget:warn' }> & { readonly perStepUsd?: number };
export type BudgetItemEvent = Exclude<BudgetEvent, { type: 'budget:warn' }> | BudgetWarnEvent;

const finite = (x: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** `$1.600` — three decimals, the item form (§24); non-finite → `$?` (the --allow-unpriced figure, §9.5). */
export function usd3(x: number): string {
  return Number.isFinite(x) ? `$${x.toFixed(3)}` : '$?';
}

/** `$4.11` — two decimals, the status / box form (§24); +Infinity → `none` (an uncapped session). */
export function usd2(x: number): string {
  if (x === Number.POSITIVE_INFINITY) return 'none';
  return Number.isFinite(x) ? `$${x.toFixed(2)}` : '$?';
}

/** `1,204` — grouped integer for question counts. */
export function grouped(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?';
}

/**
 * TUI-DESIGN §9.2: `floor(100 × spent / cap)`; null for an uncapped (+Infinity) meter; a NaN / negative / zero cap fails
 * closed like `sanitiseCap` (cap 0): 100 once anything is spent, else 0.
 */
export function budgetPct(spentUsd: number, capUsd: number): number | null {
  if (capUsd === Number.POSITIVE_INFINITY) return null;
  const cap = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0;
  const spent = Math.max(0, finite(spentUsd));
  if (cap === 0) return spent > 0 ? 100 : 0;
  return Math.floor((100 * spent) / cap);
}

/** TUI-DESIGN §24: `ok` < 50 %, `half` < 80 %, `high` < 95 %, `critical` < 100 %, `over` ≥ 100 %, `uncapped` for +Infinity. */
export function meterWord(spentUsd: number, capUsd: number): MeterWord {
  const pct = budgetPct(spentUsd, capUsd);
  if (pct === null) return 'uncapped';
  if (pct >= 100) return 'over';
  if (pct >= 95) return 'critical';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'half';
  return 'ok';
}

/** TUI-DESIGN §9.6 / §24 right-zone meters: `run $1.60/2.00 high` · `sess $4.11/10.00 ok` · `sess $4.11/none uncapped`. */
export function meterText(scope: 'run' | 'session', spentUsd: number, capUsd: number): string {
  const label = scope === 'run' ? 'run' : 'sess';
  const cap = capUsd === Number.POSITIVE_INFINITY ? 'none' : Number.isFinite(capUsd) ? capUsd.toFixed(2) : '?';
  return `${label} ${usd2(Math.max(0, finite(spentUsd)))}/${cap} ${meterWord(spentUsd, capUsd)}`;
}

/** Every threshold at or below the current percentage (ascending); empty for an uncapped meter. */
export function crossedThresholds(spentUsd: number, capUsd: number): BudgetPct[] {
  const pct = budgetPct(spentUsd, capUsd);
  if (pct === null) return [];
  return BUDGET_THRESHOLDS.filter((t) => pct >= t);
}

export interface ThresholdStep {
  /** the threshold to announce now (the highest newly crossed one), or null */
  warn: { pct: BudgetPct; restored: boolean } | null;
  /** the announced set after this add: every crossed threshold, so a lower one is never announced later */
  announced: ReadonlySet<BudgetPct>;
}

export interface NextBudgetWarnOptions {
  /**
   * TUI-DESIGN §9.2: the spend restored from the checkpoint on this resume. A threshold that spend had already crossed
   * is re-announced with `restored: true`; a threshold first crossed by this add is a fresh crossing (`restored: false`)
   * even right after a resume.
   */
  restoredSpentUsd?: number;
}

/**
 * TUI-DESIGN §9.2: after every `meter.add()` — emit once per `(scope, pct)`, the highest only when one add crosses two,
 * never for +Infinity. `announced` is the per-run set (the session set is seeded by the controller with
 * `seedAnnounced`). `restored` is decided here, from `restoredSpentUsd`, so the flag never depends on call order.
 */
export function nextBudgetWarn(spentUsd: number, capUsd: number, announced: ReadonlySet<BudgetPct>, opts: NextBudgetWarnOptions = {}): ThresholdStep {
  const crossed = crossedThresholds(spentUsd, capUsd);
  const fresh = crossed.filter((t) => !announced.has(t));
  if (fresh.length === 0) return { warn: null, announced };
  const next = new Set<BudgetPct>(announced);
  for (const t of fresh) next.add(t);
  const pct = fresh[fresh.length - 1]!;
  const restored = opts.restoredSpentUsd !== undefined && crossedThresholds(opts.restoredSpentUsd, capUsd).includes(pct);
  return { warn: { pct, restored }, announced: next };
}

/**
 * TUI-DESIGN §9.2: the one re-announcement right after a resume — the highest threshold the restored spend had already
 * crossed, flagged `restored: true`, and the per-run announced set seeded with every crossed threshold. `warn` is null
 * (and the set empty) when nothing was crossed or the meter is uncapped. Self-sufficient: no meter call has to precede it.
 */
export function restoredBudgetWarn(restoredSpentUsd: number, capUsd: number): ThresholdStep {
  const crossed = crossedThresholds(restoredSpentUsd, capUsd);
  if (crossed.length === 0) return { warn: null, announced: new Set<BudgetPct>() };
  return { warn: { pct: crossed[crossed.length - 1]!, restored: true }, announced: new Set<BudgetPct>(crossed) };
}

/** TUI-DESIGN §9.2: the session set a new run starts with — thresholds earlier runs already crossed are not re-announced. */
export function seedAnnounced(spentUsd: number, capUsd: number): Set<BudgetPct> {
  return new Set<BudgetPct>(crossedThresholds(spentUsd, capUsd));
}

/** `about N steps left` at the recent per-step cost; null when the rate is unknown, zero or the meter is uncapped. */
export function stepsLeftEstimate(spentUsd: number, capUsd: number, perStepUsd: number | null): number | null {
  if (perStepUsd === null || !Number.isFinite(perStepUsd) || perStepUsd <= 0) return null;
  if (!Number.isFinite(capUsd)) return null;
  const remaining = capUsd - finite(spentUsd);
  // 1e-9 absorbs binary rounding (1.7 / 0.1 = 16.999999999999996) so the estimate never under-counts by one
  return remaining <= 0 ? 0 : Math.floor(remaining / perStepUsd + 1e-9);
}

/** ` — Jev is the larger share ($0.031 vs $0.020); see /jev` when Jev outspent the generator at a crossing (§9.2). */
function jevShareSuffix(share: { jevUsd: number; generatorUsd: number } | undefined): string {
  if (!share || !(finite(share.jevUsd) > finite(share.generatorUsd))) return '';
  return ` — Jev is the larger share (${usd3(share.jevUsd)} vs ${usd3(share.generatorUsd)}); see /jev`;
}

const STOPPED_AT_TEXT: Readonly<Record<string, string>> = { step_start: 'step start', before_execute: 'before execute', complete: 'completion' };

/** The measured per-step rate of a run warning; null when the event does not carry one (or it is not a positive finite number). */
function perStepRate(e: BudgetWarnEvent): number | null {
  return typeof e.perStepUsd === 'number' && Number.isFinite(e.perStepUsd) && e.perStepUsd > 0 ? e.perStepUsd : null;
}

/**
 * TUI-DESIGN §24 engine items for the five budget events — the text after the `[run]` / `[step N]` label that
 * `formatTranscriptItem` prepends; one line each, the run/session `budget:warn` variants per §9.2. The §24 strings are
 * rendered verbatim: `restored` is carried by the event for the renderers, never appended to the text; ` at $c/step`
 * appears only with a measured `perStepUsd` (never back-derived from the floored `stepsLeftEstimate`).
 */
export function budgetItems(e: BudgetItemEvent): string[] {
  switch (e.type) {
    case 'budget:warn': {
      if (e.scope === 'run') {
        const rate = perStepRate(e);
        const tail = e.stepsLeftEstimate === null ? '' : ` — about ${e.stepsLeftEstimate} steps left${rate === null ? '' : ` at ${usd3(rate)}/step`}`;
        return [`budget: run spend ${usd3(e.spentUsd)} is ${e.pct} % of the ${usd3(e.capUsd)} run cap${tail}${jevShareSuffix(e.jevShare)}`];
      }
      return [`budget: session spend ${usd3(e.spentUsd)} is ${e.pct} % of the ${usd3(e.capUsd)} session cap — raise it with /budget session-spend-cap <usd>${jevShareSuffix(e.jevShare)}`];
    }
    case 'budget:stop':
      return [`budget stop: ${e.by} cap ${e.by === 'tokens' ? `${grouped(e.capUsd)} tokens` : usd3(e.capUsd)} reached at ${STOPPED_AT_TEXT[e.at] ?? e.at} — raise: ${e.raise.command}`];
    case 'budget:clamp':
      return [`budget: run cap clamped to ${usd3(e.clampedToUsd)} (session ${usd3(e.sessionSpentUsd)} of ${usd3(e.sessionCapUsd)})`];
    case 'budget:override':
      return [`budget override: ${e.setting} ${e.from} → ${e.to} (applies to this resume)`];
    case 'budget:unpriced':
      return [`budget: ${e.side} usage.cost missing for ${e.model} — unpriced`];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------
// Follow-up confirm and refusal (§9.3)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §9.1: `remaining = sessionCap − sessionSpent` (+Infinity when uncapped; never below 0 for the box maths). */
export function sessionRemainingUsd(sessionCapUsd: number, sessionSpentUsd: number): number {
  if (sessionCapUsd === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return finite(sessionCapUsd) - Math.max(0, finite(sessionSpentUsd));
}

/** TUI-DESIGN §9.1: every run's child cap is `min(runCap, remaining)`, computed before the run's own spend is added. */
export function childCapUsd(runCapUsd: number, sessionCapUsd: number, sessionSpentUsd: number): number {
  const remaining = sessionRemainingUsd(sessionCapUsd, sessionSpentUsd);
  return Math.max(0, Math.min(finite(runCapUsd), remaining));
}

export type FollowUpDecision = 'start' | 'confirm' | 'refuse';

/** TUI-DESIGN §9.3: `remaining ≥ runCap` → start; `0 < remaining < runCap` → the y/r/n box; `remaining ≤ 0` → refuse. */
export function followUpDecision(runCapUsd: number, sessionCapUsd: number, sessionSpentUsd: number): FollowUpDecision {
  const remaining = sessionRemainingUsd(sessionCapUsd, sessionSpentUsd);
  if (remaining <= 0) return 'refuse';
  return remaining >= finite(runCapUsd) ? 'start' : 'confirm';
}

export interface FollowUpBoxInput {
  runCapUsd: number;
  sessionCapUsd: number;
  sessionSpentUsd: number;
  /** finished runs in the session */
  runs: number;
  /** the last run's spend; null before any run finished */
  lastRunUsd: number | null;
}

/**
 * TUI-DESIGN §9.3 / §24 follow-up box rows: title, keys, session line, the Enter note. `rows` truncates from the
 * bottom (3 rows = title, keys, session line, the design's truncation); 0 → nothing.
 */
export function followUpBoxLines(i: FollowUpBoxInput, rows = 4): string[] {
  const clamped = childCapUsd(i.runCapUsd, i.sessionCapUsd, i.sessionSpentUsd);
  const lines = [
    'follow-up would exceed the session cap',
    `[y] start, run cap clamped to ${usd2(clamped)}   [r] raise session cap   [n]/Esc cancel`,
    `session ${usd2(i.sessionSpentUsd)} of ${usd2(i.sessionCapUsd)} (${i.runs} run${i.runs === 1 ? '' : 's'}) · run cap ${usd2(i.runCapUsd)} · last run ${i.lastRunUsd === null ? '—' : usd2(i.lastRunUsd)}`,
    'Enter does nothing here. A clamped run stops at the session cap (spend_cap).',
  ];
  return lines.slice(0, Math.max(0, Math.min(lines.length, Math.floor(finite(rows)))));
}

/** TUI-DESIGN §9.3: the `r` prefill — `/budget session-spend-cap <sessionCap + runCap>`. */
export function raiseSessionCapCommand(sessionCapUsd: number, runCapUsd: number): string {
  return `/budget session-spend-cap ${(finite(sessionCapUsd) + finite(runCapUsd)).toFixed(2)}`;
}

/** TUI-DESIGN §24: `session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.` */
export function sessionCapReachedItem(sessionSpentUsd: number, sessionCapUsd: number): string {
  return `session cap reached (${usd2(sessionSpentUsd)} of ${usd2(sessionCapUsd)}). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.`;
}

/** TUI-DESIGN §9.4 / §24: `budget: session cap $10.00 → $15.00 (applies now)` (`none` for +Infinity). */
export function sessionCapChangedLine(fromUsd: number, toUsd: number): string {
  return `budget: session cap ${usd2(fromUsd)} → ${usd2(toUsd)} (applies now)`;
}

/** TUI-DESIGN §24: `budget: <setting> <v> pending (next /resume or run)`. */
export function pendingBudgetLine(setting: string, value: string): string {
  return `budget: ${setting} ${value} pending (next /resume or run)`;
}

/** TUI-DESIGN §9.4: `/budget spend-cap <v>` must exceed the target run's spend. */
export function spendCapRaiseError(valueUsd: number, runSpentUsd: number): string | null {
  if (finite(valueUsd) > finite(runSpentUsd)) return null;
  return `/budget spend-cap ${valueUsd.toFixed(2)} is not above this run's spend ${usd3(runSpentUsd)}; give a larger value`;
}

// ---------------------------------------------------------------------------------------
// Epilogue for a spend-cap stop (§9.4) and /cost (§9.6)
// ---------------------------------------------------------------------------------------

/**
 * The raise the epilogue suggests (§9.4 / §19.7 row 4: `$1.500` → `3.00`, `$2.000` → `3.00`): the whole dollar above
 * the cap plus one, and always strictly above the spend (`floor(spent) + 1`).
 */
export function suggestedSpendCapUsd(capUsd: number, spentUsd: number): number {
  const cap = Math.max(0, finite(capUsd));
  const spent = Math.max(0, finite(spentUsd));
  return Math.max(Math.ceil(cap) + 1, Math.floor(spent) + 1);
}

export interface SpendCapEpilogueInput {
  by: 'run' | 'session';
  spentUsd: number;
  capUsd: number;
  sessionSpentUsd: number;
  sessionCapUsd: number;
  /** what the last paid call was, e.g. `one judge call`; omitted when unknown */
  lastCall?: string;
}

/**
 * TUI-DESIGN §9.4 / §24 `[ui]` epilogue rows for a `spend_cap` stop in session mode: the run variant names
 * `/budget spend-cap <usd> then /resume` and the fresh-cap follow-up; the session variant names
 * `/budget session-spend-cap` and the refusal.
 */
export function spendCapEpilogueLines(i: SpendCapEpilogueInput): string[] {
  const over = Math.max(0, finite(i.spentUsd) - finite(i.capUsd));
  const call = i.lastCall ? `, ${i.lastCall}` : '';
  if (i.by === 'run') {
    return [
      `stopped by the run spend cap: ${usd3(i.spentUsd)} of ${usd3(i.capUsd)} (over by ${usd3(over)}${call}). Session ${usd2(i.sessionSpentUsd)}/${usd2(i.sessionCapUsd)} ${meterWord(i.sessionSpentUsd, i.sessionCapUsd)}.`,
      `continue this run: /budget spend-cap ${suggestedSpendCapUsd(i.capUsd, i.spentUsd).toFixed(2)} then /resume`,
      `or start a follow-up run with a fresh ${usd3(i.capUsd)} cap`,
    ];
  }
  return [
    `stopped by the session spend cap: ${usd3(i.sessionSpentUsd)} of ${usd3(i.sessionCapUsd)} (over by ${usd3(Math.max(0, finite(i.sessionSpentUsd) - finite(i.sessionCapUsd)))}${call}).`,
    `raise it: /budget session-spend-cap ${suggestedSpendCapUsd(i.sessionCapUsd, i.sessionSpentUsd).toFixed(2)} (or none), then type a follow-up`,
    'or /new for a fresh session with its own cap',
  ];
}

export interface CostBlockInput {
  mode: EngineMode;
  /** the current or last run; null before any run */
  run: { spentUsd: number; capUsd: number; perStepUsd: readonly number[] } | null;
  session: { spentUsd: number; capUsd: number; runs: number };
  gen: { usd: number; tablePriced: boolean } | null;
  jev: { usd: number; questions: number; p50Ms: number | null } | null;
  basis: { generator: string | null; jev: string | null };
  pending: readonly { setting: string; value: string }[];
  /** --allow-unpriced: figures render `$?` */
  unpriced?: boolean;
}

/**
 * TUI-DESIGN-3 §5.1 rule 6: the per-question figure of `/cost` — `~$0.000006`, six decimals with the trailing zeros
 * dropped (never scientific notation; `~$0.00002`, `~$0.0`); non-finite → `~$?`.
 */
export function eachUsdText(each: number): string {
  if (!Number.isFinite(each)) return '~$?';
  const fixed = each.toFixed(6).replace(/0+$/, '');
  return `~$${fixed.endsWith('.') ? `${fixed}0` : fixed}`;
}

function median(xs: readonly number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** TUI-DESIGN §9.6 `/cost`: one `[ui]` block of at most 12 rows; jev-only drops `gen`. */
export function costBlock(i: CostBlockInput): string[] {
  const out: string[] = [];
  const money = (x: number): string => (i.unpriced ? '$?' : usd3(x));
  if (i.run) {
    const pct = budgetPct(i.run.spentUsd, i.run.capUsd);
    out.push(`run ${money(i.run.spentUsd)} of ${usd3(i.run.capUsd)}${pct === null ? '' : ` (${pct} %)`}`);
  }
  const spct = budgetPct(i.session.spentUsd, i.session.capUsd);
  out.push(`session ${usd2(i.session.spentUsd)} of ${usd2(i.session.capUsd)} (${spct === null ? 'uncapped' : `${spct} %`}, ${i.session.runs} run${i.session.runs === 1 ? '' : 's'})`);
  if (i.run && i.run.perStepUsd.length > 0) {
    const p50 = median(i.run.perStepUsd);
    const last = i.run.perStepUsd[i.run.perStepUsd.length - 1]!;
    const left = stepsLeftEstimate(i.run.spentUsd, i.run.capUsd, last);
    out.push(`per step p50 ${p50 === null ? '$?' : money(p50)} · last ${money(last)}${left === null ? '' : ` · about ${left} steps left`}`);
  }
  const parts: string[] = [];
  if (i.mode !== 'jev-only' && i.gen) parts.push(`gen ${money(i.gen.usd)}${i.gen.tablePriced ? ' (~ table-priced)' : ''}`);
  if (i.jev) {
    const each = i.jev.questions > 0 ? i.jev.usd / i.jev.questions : null;
    const eachText = each === null ? '' : ` (${eachUsdText(each)} each${i.jev.p50Ms === null ? '' : `, p50 ${Math.round(i.jev.p50Ms)} ms`})`;
    parts.push(`jev ${usd3(i.jev.usd)} for ${grouped(i.jev.questions)} questions${eachText}`);
  }
  if (parts.length > 0) out.push(parts.join(' · '));
  const basis: string[] = [];
  if (i.mode !== 'jev-only' && i.basis.generator) basis.push(`generator ${i.basis.generator}`);
  if (i.basis.jev) basis.push(`jev ${i.basis.jev}`);
  if (basis.length > 0) out.push(`basis: ${basis.join(', ')}`);
  for (const p of i.pending.slice(0, 4)) out.push(`pending: ${p.setting} ${p.value} (next /resume or run)`);
  out.push('raise: /budget spend-cap <usd> · /budget session-spend-cap <usd|none>');
  return out.slice(0, 12);
}
