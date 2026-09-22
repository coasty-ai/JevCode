/**
 * Tiered history (docs/COORDINATION-DESIGN.md §8.3): the generator's ≥ 12 recent steps. Each entry is the WindowEntry the
 * 4-step Jev window also holds (600-char body, unchanged) plus a pointer to the whole output on disk. `state.json` stays small:
 * the long text lives in `<runDir>/outputs/step-<n>.txt` and is expanded at prompt build from an in-memory `OutputView`
 * (head 24 KiB + tail 8 KiB, memoised per step) — the newest 2 entries whole up to 32 KiB, entries 3–6 head 4k + tail 2k, 7–12
 * one line. Every clip names the path to the full text (§8.5): `…[N chars omitted; full text: read jevcode:outputs/step-7.txt]…`.
 * Pure; the engine replaces its array at the commit point only (DESIGN §11 state-mutation rule).
 *
 * §8.2(a) (revision 4): the section allowance wins and **the fit is computed before the read**. `planHistory` costs every
 * entry from `fullOutputChars` — which is already in the entry — and degrades it down the ladder
 * `whole (32 KiB) → clipped (headTail(12k, 4k)) → mid (headTail(4k, 2k)) → the 600-char body → the one-liner`
 * until the 30 % allowance holds, oldest first, so the newest survives longest (§8.2(c): at the 60k floor the newest is the
 * one clipped, to 16k, and `/context` says so). Only the tiers that survive are read from disk (`stepsNeedingViews`).
 */
import { clip } from '../../core/text.js';
import type { StepRecord, WindowEntry } from '../../core/types.js';
import { foldStepRecord, outcomeOutput } from '../window.js';
import {
  HISTORY_CLIPPED_HEAD,
  HISTORY_CLIPPED_TAIL,
  HISTORY_MID,
  HISTORY_MID_HEAD,
  HISTORY_MID_TAIL,
  HISTORY_STEPS,
  HISTORY_WHOLE,
  HISTORY_WHOLE_HEAD,
  HISTORY_WHOLE_TAIL,
  OUTPUT_FILE_MIN_CHARS,
  OUTPUT_READ_PREFIX,
} from './limits.js';
import type { HistoryEntry } from '../../core/types.js';

export const OUTPUTS_DIR = 'outputs';
const OUTPUT_REF_RE = /^outputs\/step-([1-9]\d{0,8})\.txt$/;

/** `outputs/step-<n>.txt` — the run-relative file the whole output of step n is written to. */
export function outputRefFor(step: number): string {
  return `${OUTPUTS_DIR}/step-${step}.txt`;
}

/** `jevcode:outputs/step-<n>.txt` — the `read` pseudo-path that serves the file from the run dir (§8.3). */
export function outputReadPath(ref: string): string {
  return `${OUTPUT_READ_PREFIX}${ref}`;
}

/** The step an output ref or its `jevcode:` pseudo-path names; null for anything else (never joined into a path otherwise). */
export function parseOutputRef(pathOrRef: string): number | null {
  const ref = pathOrRef.startsWith(OUTPUT_READ_PREFIX) ? pathOrRef.slice(OUTPUT_READ_PREFIX.length) : pathOrRef;
  const m = OUTPUT_REF_RE.exec(ref);
  if (!m) return null;
  const step = Number(m[1]);
  return Number.isSafeInteger(step) && step >= 1 ? step : null;
}

/** True when the output is longer than the 600-char window body, i.e. the body is a clip and the whole text must be on disk. */
export function needsOutputFile(output: string | null): output is string {
  return output !== null && output.length > OUTPUT_FILE_MIN_CHARS;
}

/**
 * A WindowEntry plus the pointer to its whole output; `entry` is copied, never aliased. `output` must be the WHOLE text —
 * a caller that only has the already-clipped window body passes null (review D21: a seeded follow-up used to record the
 * 600-char body's length as `fullOutputChars`, so the one-liner claimed a 664-char output for a 40 KiB run).
 */
export function buildHistoryEntry(entry: WindowEntry, output: string | null, outputRef: string | null): HistoryEntry {
  const h: HistoryEntry = { ...entry, shownFiles: [...entry.shownFiles], notes: [...entry.notes] };
  if (output !== null && output.length > 0) h.fullOutputChars = output.length;
  if (outputRef !== null) h.outputRef = outputRef;
  return h;
}

/**
 * §8.3 / review D21: the entry a seed carries over from a parent run. The parent's `outputs/` live in the parent's run dir,
 * so there is no pointer and no honest `fullOutputChars` — a body the parent already clipped (`truncated`) says only that.
 */
export function seedHistoryEntry(entry: WindowEntry): HistoryEntry {
  const h: HistoryEntry = { ...entry, shownFiles: [...entry.shownFiles], notes: [...entry.notes] };
  if (entry.truncated !== true && entry.output !== undefined && entry.output.length > 0) h.fullOutputChars = entry.output.length;
  return h;
}

/** Returns a new array with `entry` appended and only the newest `max` kept (oldest first, like the window). */
export function pushHistory(history: readonly HistoryEntry[], entry: HistoryEntry, max: number = HISTORY_STEPS): HistoryEntry[] {
  const bound = Math.max(1, Math.floor(max));
  const next = [...history, entry];
  return next.length > bound ? next.slice(next.length - bound) : next;
}

/** --resume: fold a steps.jsonl record that was never checkpointed (window.ts's entry plus the pointer when the output was long). */
export function foldHistoryRecord(history: readonly HistoryEntry[], record: StepRecord, max: number = HISTORY_STEPS): HistoryEntry[] {
  const entry = foldStepRecord([], record)[0];
  if (entry === undefined) return [...history];
  const output = outcomeOutput(record.outcome);
  return pushHistory(history, buildHistoryEntry(entry, output, needsOutputFile(output) ? outputRefFor(record.step) : null), max);
}

// ---------------------------------------------------------------------------------------
// Output views (what the engine memoises per step instead of the whole text)
// ---------------------------------------------------------------------------------------

/** Head 24 KiB + tail 8 KiB of an output and its total length: enough for every tier, never more than 32 KiB in memory. */
export interface OutputView {
  head: string;
  tail: string;
  chars: number;
}

export function outputView(text: string): OutputView {
  if (text.length <= HISTORY_WHOLE_HEAD + HISTORY_WHOLE_TAIL) return { head: text, tail: '', chars: text.length };
  return { head: text.slice(0, HISTORY_WHOLE_HEAD), tail: text.slice(text.length - HISTORY_WHOLE_TAIL), chars: text.length };
}

/** §8.5: the omission marker always names where the rest is. */
export function omittedMarker(dropped: number, ref: string | null): string {
  return ref === null ? `\n…[${dropped} chars omitted]…\n` : `\n…[${dropped} chars omitted; full text: read ${outputReadPath(ref)}]…\n`;
}

/** Head `head` + marker + tail `tail` of the text a view stands for; the whole text when it fits. */
export function tierText(view: OutputView, head: number, tail: number, ref: string | null, gone?: string): string {
  if (view.chars <= head + tail) return view.head + view.tail;
  const headText = view.head.slice(0, head);
  const source = view.tail.length >= tail ? view.tail : view.head + view.tail;
  const tailText = tail > 0 ? source.slice(source.length - tail) : '';
  const dropped = view.chars - head - tail;
  const marker = ref === null && gone !== undefined ? `\n…[${dropped} chars omitted; ${gone}]…\n` : omittedMarker(dropped, ref);
  return headText + marker + tailText;
}

// ---------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------

/**
 * §8.2(a) ladder, widest first. `whole` = headTail(24k, 8k), `clipped` = headTail(12k, 4k), `mid` = headTail(4k, 2k),
 * `body` = the 600-char window body already in `state.json`, `line` = the one-liner with its pointer.
 */
export type HistoryTier = 'whole' | 'clipped' | 'mid' | 'body' | 'line';

export const TIER_LADDER: readonly HistoryTier[] = ['whole', 'clipped', 'mid', 'body', 'line'];

/** head + tail of a tier; `body` and `line` read nothing from disk. */
export const TIER_CUT: Readonly<Record<HistoryTier, { head: number; tail: number }>> = {
  whole: { head: HISTORY_WHOLE_HEAD, tail: HISTORY_WHOLE_TAIL },
  clipped: { head: HISTORY_CLIPPED_HEAD, tail: HISTORY_CLIPPED_TAIL },
  mid: { head: HISTORY_MID_HEAD, tail: HISTORY_MID_TAIL },
  body: { head: OUTPUT_FILE_MIN_CHARS, tail: 0 },
  line: { head: 0, tail: 0 },
};

/** The tier §8.3 asks for at a position (0 = the newest), before the allowance degrades it. */
export function tierOf(indexFromNewest: number): HistoryTier {
  if (indexFromNewest < HISTORY_WHOLE) return 'whole';
  if (indexFromNewest < HISTORY_MID) return 'mid';
  return 'line';
}

/** One rung down the ladder; `line` is the floor. */
export function degrade(tier: HistoryTier): HistoryTier {
  const i = TIER_LADDER.indexOf(tier);
  return i < 0 || i >= TIER_LADDER.length - 1 ? 'line' : TIER_LADDER[i + 1]!;
}

export interface RenderedHistoryEntry {
  entry: HistoryEntry;
  tier: HistoryTier;
  /** the output text for the expanded tiers (already clipped with a named marker); null when there is nothing to show */
  output: string | null;
  /** the one-line form (`[step n] <action> → <outcome> (<chars> chars; full text: read jevcode:outputs/step-n.txt)`) */
  line: string;
}

/**
 * §8.5 / review finding 22: a pointer that cannot be followed (the run dir was mirrored without `outputs/`, or the 64 MiB
 * bound deleted the file) must say so — a pointer at nothing is exactly the silent clip G3(a) forbids.
 */
export const OUTPUT_GONE = 'full text no longer on disk';
/** §8.5 / review D12: the file was deleted by the per-run 64 MiB bound while this run was still going. */
export const OUTPUT_EVICTED = 'full text dropped by the 64 MiB per-run output bound';

function goneText(e: HistoryEntry): string {
  return e.outputEvicted === true ? OUTPUT_EVICTED : OUTPUT_GONE;
}

/** True when this entry's pointer cannot be followed on this device. */
export function pointerLost(e: HistoryEntry, missing: boolean): boolean {
  return e.outputRef !== undefined && (missing || e.outputEvicted === true);
}

/** The one-line form of an entry (the `line` tier, and every entry a compaction collapsed). */
export function oneLiner(e: HistoryEntry, missing = false): string {
  // review D21: a body the parent already clipped knows only its own length — say `≥`, never claim it is the whole output
  const atLeast = e.fullOutputChars === undefined && e.truncated === true ? '≥ ' : '';
  const chars = `${atLeast}${e.fullOutputChars ?? e.output?.length ?? 0}`;
  const pointer = e.outputRef === undefined ? '' : pointerLost(e, missing) ? `; ${goneText(e)}` : `; full text: read ${outputReadPath(e.outputRef)}`;
  const reason = e.reason !== undefined && e.reason.length > 0 ? ` — ${clip(e.reason.replace(/\s+/g, ' ').trim(), 120)}` : '';
  return `[step ${e.step}] ${e.action} → ${e.outcome ?? 'not reached'}${reason} (${chars} chars${pointer})`;
}

/** The whole output's length as the entry knows it, without reading anything. */
export function fullChars(e: HistoryEntry): number {
  return Math.max(e.fullOutputChars ?? 0, e.output?.length ?? 0);
}

/** What the rendered form of one entry at one tier costs, from `fullOutputChars` alone — no read (§8.2(a)). */
export function tierCost(e: HistoryEntry, tier: HistoryTier): number {
  if (tier === 'line') return oneLiner(e).length + 3;
  const cut = TIER_CUT[tier];
  const shown = Math.min(fullChars(e), cut.head + cut.tail);
  // the entry header (`### step N: …`, intent/outcome/reason/notes) plus the fenced output block
  const header = 40 + e.action.length + (e.reason?.length ?? 0) + e.notes.reduce((n, t) => n + t.length + 8, 0) + e.shownFiles.reduce((n, t) => n + t.length + 2, 0);
  return header + shown + 24;
}

export interface HistoryPlanEntry {
  entry: HistoryEntry;
  tier: HistoryTier;
  /** the tier §8.3 asked for before the allowance degraded it */
  wanted: HistoryTier;
  cost: number;
}

export interface HistoryPlan {
  /** oldest first, as stored */
  entries: HistoryPlanEntry[];
  chars: number;
  allowanceChars: number;
  whole: number;
  clipped: number;
  oneLine: number;
  /** the steps whose `outputs/step-<n>.txt` the surviving tiers need — nothing else is opened */
  reads: number[];
  /** §8.2(c): the newest entry was degraded below `whole`, so the prompt must say where the rest is */
  newestClipped: boolean;
}

/**
 * §8.2(a): assemble newest-first against the allowance, costing each tier from `fullOutputChars` and degrading the OLDEST
 * expanded entry first, so the newest keeps its content longest. Pure and I/O-free: the result names the ≤ 6 files worth
 * opening.
 */
export function planHistory(history: readonly HistoryEntry[], allowanceChars: number): HistoryPlan {
  const n = history.length;
  const plan: HistoryPlanEntry[] = history.map((entry, idx) => {
    const wanted = tierOf(n - 1 - idx);
    // an entry that carries nothing beyond its one-liner (no output, judge, notes or shown files) cannot show more
    // whatever the allowance — but one with notes, a reason or a judge still renders its header lines
    const tier = isOneLine(entry) ? 'line' : wanted;
    return { entry, wanted, tier, cost: tierCost(entry, tier) };
  });
  const allowance = Math.max(0, Math.floor(allowanceChars));
  let total = plan.reduce((sum, p) => sum + p.cost, 0);
  // degrade oldest-first until it fits (or everything is a one-liner)
  for (let guard = 0; total > allowance && guard < plan.length * TIER_LADDER.length; guard++) {
    const victim = plan.find((p) => p.tier !== 'line');
    if (victim === undefined) break;
    total -= victim.cost;
    victim.tier = degrade(victim.tier);
    victim.cost = tierCost(victim.entry, victim.tier);
    total += victim.cost;
  }
  const reads: number[] = [];
  for (const p of plan) if (p.tier !== 'line' && p.tier !== 'body' && p.entry.outputRef !== undefined && p.entry.outputEvicted !== true) reads.push(p.entry.step);
  reads.reverse();
  const newest = plan[plan.length - 1];
  return {
    entries: plan,
    chars: total,
    allowanceChars: allowance,
    whole: plan.filter((p) => p.tier === 'whole').length,
    clipped: plan.filter((p) => p.tier === 'clipped' || p.tier === 'mid' || p.tier === 'body').length,
    oneLine: plan.filter((p) => p.tier === 'line').length,
    reads,
    newestClipped: newest !== undefined && newest.wanted === 'whole' && newest.tier !== 'whole' && fullChars(newest.entry) > TIER_CUT[newest.tier].head + TIER_CUT[newest.tier].tail,
  };
}

function outputFor(e: HistoryEntry, tier: Exclude<HistoryTier, 'line'>, view: OutputView | null, missing: boolean): string | null {
  const lost = pointerLost(e, missing);
  const ref = lost ? null : (e.outputRef ?? null);
  const cut = TIER_CUT[tier];
  if (tier !== 'body' && view !== null && view.chars > 0) return tierText(view, cut.head, cut.tail, ref, lost ? goneText(e) : undefined);
  // the body tier, or no view (a resumed run whose output file is gone): the 600-char body, with the pointer when it is a clip
  if (e.output === undefined || e.output.length === 0) return null;
  if (fullChars(e) <= e.output.length) return e.output;
  const where = ref === null ? goneText(e) : `full text: read ${outputReadPath(ref)}`;
  return `${e.output}\n[${fullChars(e)} chars in total; ${where}]`;
}

/** Where the expansion of one prompt's history comes from: memoised head+tail views, and which refs cannot be followed. */
export interface HistoryViewSource {
  /** the memoised OutputView of a step, null when none is held */
  view(step: number): OutputView | null;
  /** true when the step's `outputRef` names a file this device does not have (§8.5: the pointer is replaced, never dangled) */
  missing?(step: number): boolean;
}

/**
 * Render a plan (oldest first, as stored). Pure and I/O-free — the engine reads `plan.reads` BEFORE calling and records
 * the ones that were not there as `missing`.
 */
export function renderHistory(plan: HistoryPlan, source: HistoryViewSource): RenderedHistoryEntry[] {
  return plan.entries.map(({ entry, tier }) => {
    const missing = entry.outputRef !== undefined && (source.missing?.(entry.step) ?? false);
    return { entry, tier, output: tier === 'line' ? null : outputFor(entry, tier, source.view(entry.step), missing), line: oneLiner(entry, missing) };
  });
}

/** Plan + render in one call, for callers that do not need the two apart (tests, the legacy-shaped path). */
export function expandHistory(history: readonly HistoryEntry[], source: HistoryViewSource, allowanceChars = Number.MAX_SAFE_INTEGER): RenderedHistoryEntry[] {
  return renderHistory(planHistory(history, allowanceChars), source);
}

/** The steps whose OutputView a prompt build will consult, newest first. */
export function stepsNeedingViews(history: readonly HistoryEntry[], allowanceChars = Number.MAX_SAFE_INTEGER): number[] {
  return planHistory(history, allowanceChars).reads;
}

// ---------------------------------------------------------------------------------------
// Compaction support (§8.6): older entries collapse to their one-line facts
// ---------------------------------------------------------------------------------------

/** What survives of an entry after a compaction: step, action, outcome, a short reason, the completion and the pointer. */
export function collapseEntry(e: HistoryEntry): HistoryEntry {
  const out: HistoryEntry = { step: e.step, intent: e.intent, action: e.action, outcome: e.outcome, shownFiles: [], notes: [] };
  if (e.reason !== undefined) out.reason = clip(e.reason, 120);
  if (e.completion !== undefined) out.completion = e.completion;
  if (e.outputRef !== undefined) out.outputRef = e.outputRef;
  if (e.fullOutputChars !== undefined) out.fullOutputChars = e.fullOutputChars;
  return out;
}

/** True when an entry carries nothing beyond its one-line facts (a collapsed entry, or a step with no output, judge or notes). */
export function isOneLine(e: HistoryEntry): boolean {
  return (e.output === undefined || e.output.length === 0) && e.judge === undefined && e.notes.length === 0 && e.shownFiles.length === 0;
}

/**
 * How many entries a fold would actually collapse (review finding 53: `compactions` moves only when entries were folded, so a
 * resume-heavy run sees the same history as an uninterrupted one).
 */
export function foldableCount(history: readonly HistoryEntry[], keepNewest: number = HISTORY_WHOLE): number {
  const cut = Math.max(0, history.length - Math.max(0, keepNewest));
  let n = 0;
  for (const e of history.slice(0, cut)) if (!isOneLine(e)) n += 1;
  return n;
}

/** Keep the newest `keepNewest` entries verbatim; every older one collapses. Returns the new array and the entries folded. */
export function collapseHistory(history: readonly HistoryEntry[], keepNewest: number = HISTORY_WHOLE): { history: HistoryEntry[]; folded: HistoryEntry[] } {
  const cut = Math.max(0, history.length - Math.max(0, keepNewest));
  const folded = history.slice(0, cut).filter((e) => !isOneLine(e));
  return { history: [...history.slice(0, cut).map(collapseEntry), ...history.slice(cut)], folded };
}
