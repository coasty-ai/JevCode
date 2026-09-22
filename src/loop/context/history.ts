/**
 * Tiered history (docs/COORDINATION-DESIGN.md §8.3): the generator's ≥ 12 recent steps. Each entry is the WindowEntry the
 * 4-step Jev window also holds (600-char body, unchanged) plus a pointer to the whole output on disk. `state.json` stays small:
 * the long text lives in `<runDir>/outputs/step-<n>.txt` and is expanded at prompt build from an in-memory `OutputView`
 * (head 24 KiB + tail 8 KiB, memoised per step) — the newest 2 entries whole up to 32 KiB, entries 3–6 head 4k + tail 2k, 7–12
 * one line. Every clip names the path to the full text (§8.5): `…[N chars omitted; full text: read jevcode:outputs/step-7.txt]…`.
 * Pure; the engine replaces its array at the commit point only (DESIGN §11 state-mutation rule).
 */
import { clip } from '../../core/text.js';
import type { StepRecord, WindowEntry } from '../../core/types.js';
import { foldStepRecord, outcomeOutput } from '../window.js';
import { HISTORY_MID, HISTORY_MID_HEAD, HISTORY_MID_TAIL, HISTORY_STEPS, HISTORY_WHOLE, HISTORY_WHOLE_HEAD, HISTORY_WHOLE_TAIL, OUTPUT_FILE_MIN_CHARS, OUTPUT_READ_PREFIX } from './limits.js';
import type { HistoryEntry } from './types.js';

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

/** A WindowEntry plus the pointer to its whole output; `entry` is copied, never aliased. */
export function buildHistoryEntry(entry: WindowEntry, output: string | null, outputRef: string | null): HistoryEntry {
  const h: HistoryEntry = { ...entry, shownFiles: [...entry.shownFiles], notes: [...entry.notes] };
  if (output !== null && output.length > 0) h.fullOutputChars = output.length;
  if (outputRef !== null) h.outputRef = outputRef;
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
export function tierText(view: OutputView, head: number, tail: number, ref: string | null): string {
  if (view.chars <= head + tail) return view.head + view.tail;
  const headText = view.head.slice(0, head);
  const source = view.tail.length >= tail ? view.tail : view.head + view.tail;
  const tailText = tail > 0 ? source.slice(source.length - tail) : '';
  return headText + omittedMarker(view.chars - head - tail, ref) + tailText;
}

// ---------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------

export type HistoryTier = 'whole' | 'mid' | 'line';

/** 0 = the newest entry. */
export function tierOf(indexFromNewest: number): HistoryTier {
  if (indexFromNewest < HISTORY_WHOLE) return 'whole';
  if (indexFromNewest < HISTORY_MID) return 'mid';
  return 'line';
}

export interface RenderedHistoryEntry {
  entry: HistoryEntry;
  tier: HistoryTier;
  /** the output text for the whole / mid tiers (already clipped with a named marker); null when there is nothing to show */
  output: string | null;
  /** the one-line form (`[step n] <action> → <outcome> (<chars> chars; full text: read jevcode:outputs/step-n.txt)`) */
  line: string;
}

/**
 * §8.5 / review finding 22: a pointer that cannot be followed (the run dir was mirrored without `outputs/`, or the 64 MiB
 * bound deleted the file) must say so — a pointer at nothing is exactly the silent clip G3(a) forbids.
 */
export const OUTPUT_GONE = 'full text no longer on disk';

/** The one-line form of an entry (tier 7–12, and every entry a compaction collapsed). */
export function oneLiner(e: HistoryEntry, missing = false): string {
  const chars = e.fullOutputChars ?? e.output?.length ?? 0;
  const pointer = e.outputRef === undefined ? '' : missing ? `; ${OUTPUT_GONE}` : `; full text: read ${outputReadPath(e.outputRef)}`;
  const reason = e.reason !== undefined && e.reason.length > 0 ? ` — ${clip(e.reason.replace(/\s+/g, ' ').trim(), 120)}` : '';
  return `[step ${e.step}] ${e.action} → ${e.outcome ?? 'not reached'}${reason} (${chars} chars${pointer})`;
}

function outputFor(e: HistoryEntry, tier: Exclude<HistoryTier, 'line'>, view: OutputView | null, missing: boolean): string | null {
  const ref = missing ? null : (e.outputRef ?? null);
  if (view !== null && view.chars > 0) return tier === 'whole' ? tierText(view, HISTORY_WHOLE_HEAD, HISTORY_WHOLE_TAIL, ref) : tierText(view, HISTORY_MID_HEAD, HISTORY_MID_TAIL, ref);
  // no view yet (a resumed run whose output file is gone): the 600-char body, with the pointer — or the truth — when it is a clip
  if (e.output === undefined || e.output.length === 0) return null;
  if ((e.fullOutputChars ?? 0) <= e.output.length) return e.output;
  const where = ref === null ? OUTPUT_GONE : `full text: read ${outputReadPath(ref)}`;
  return `${e.output}\n[${e.fullOutputChars} chars in total; ${where}]`;
}

/** Where the expansion of one prompt's history comes from: memoised head+tail views, and which refs cannot be followed. */
export interface HistoryViewSource {
  /** the memoised OutputView of a step, null when none is held */
  view(step: number): OutputView | null;
  /** true when the step's `outputRef` names a file this device does not have (§8.5: the pointer is replaced, never dangled) */
  missing?(step: number): boolean;
}

/**
 * Expand the history for one prompt (oldest first, as stored). Pure and I/O-free — the engine reads the ≤ 2 (whole) + ≤ 4
 * (mid) output files it does not hold BEFORE calling, and records the ones that were not there as `missing`.
 */
export function expandHistory(history: readonly HistoryEntry[], source: HistoryViewSource): RenderedHistoryEntry[] {
  const n = history.length;
  return history.map((entry, idx) => {
    const tier = tierOf(n - 1 - idx);
    const missing = entry.outputRef !== undefined && (source.missing?.(entry.step) ?? false);
    return { entry, tier, output: tier === 'line' ? null : outputFor(entry, tier, source.view(entry.step), missing), line: oneLiner(entry, missing) };
  });
}

/** The steps whose OutputView a prompt build will consult (the whole and mid tiers), newest first. */
export function stepsNeedingViews(history: readonly HistoryEntry[]): number[] {
  const out: number[] = [];
  for (let i = history.length - 1, k = 0; i >= 0 && k < HISTORY_MID; i--, k++) {
    const e = history[i]!;
    if (e.outputRef !== undefined) out.push(e.step);
  }
  return out;
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
