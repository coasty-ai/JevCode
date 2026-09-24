/**
 * Loop banner (TUI-DESIGN §7.3, A45; TUI-DESIGN-3 §5.1 rule 12): one dynamic row, present only while a signature count
 * ≥ 2 or a replan directive is active — `loop · run:pytest -q›exit 1 repeated 2 of 3 · replan 1 of 5 · s6 change_approach
 * (p 0.61 · impossible 0.12)` (` · ` separators like every other row; probabilities two decimals, rule 6). Counts are
 * folded from `step:end.record.loopSignatures`, reset on `replan` and `steer:applied`, and the reducer clears the banner
 * at `run:end`. A dynamic row, never a transcript item (no identity cost). Pure; the row is ≤ `columns`.
 */
import type { ReplanDirective, StepRecord } from '../../core/types.js';
import { LOOP_TRIP_COUNT, signatureKind } from '../../loop/loopdetect.js';
import { firstLine } from '../../core/text.js';
import { GLYPHS, oneLineCells, truncateCells, type GlyphSet } from '../glyphs.js';

/** The reducer's loop view (`LoopView` in UiState 1.1, §15 item 20): the leading signature, its count and the active replan. */
export interface LoopBannerView {
  /** human form of the leading signature (`describeSignature`) */
  signature: string;
  count: number;
  /** trip count the `x2/3` denominator shows (LOOP_TRIP_COUNT) */
  max: number;
  replan: { n: number; max: number; step: number; move: string; p: number; impossible: number } | null;
}

/** The fold behind the view: per-signature counts (reset on `replan` and `steer:applied`). */
export interface LoopFold {
  counts: Readonly<Record<string, number>>;
  labels: Readonly<Record<string, string>>;
  replan: LoopBannerView['replan'];
  replans: number;
  maxReplans: number;
}

/** A fresh fold (`maxReplans` from the extended `run:ready`, §7.3). */
export function emptyLoopFold(maxReplans = 5): LoopFold {
  return { counts: {}, labels: {}, replan: null, replans: 0, maxReplans };
}

/** TUI-DESIGN §7.3: the human form of a loop signature from the step that produced it — `run:pytest -q›exit 1`, `patch:src/a.py`, `read:2 files`, `done`, `intent:unresolved`, `fail:generator`, `fail:exit 1`. */
export function describeSignature(sig: string, record: Pick<StepRecord, 'proposal' | 'outcome'> | null, g: GlyphSet = GLYPHS.unicode): string {
  const kind = signatureKind(sig);
  const action = record?.proposal?.action ?? null;
  const outcome = record?.outcome ?? null;
  const result = (): string => {
    if (!outcome) return '';
    if (outcome.status === 'executed') return outcome.exec ? `${g.chevron}exit ${outcome.exec.exitCode ?? 'null'}` : '';
    if (outcome.status === 'blocked' || outcome.status === 'declined') return `${g.chevron}refused`;
    return `${g.chevron}${outcome.status}`;
  };
  switch (kind) {
    case 'run':
      return `run:${action?.kind === 'run' ? truncateCells(oneLineCells(firstLine(action.command)), 24, g) : sig.slice(4, 16)}${result()}`;
    case 'patch':
      return `patch:${action && (action.kind === 'edit' || action.kind === 'write') ? action.path : action?.kind === 'patch' ? 'diff' : sig.slice(6, 18)}`;
    case 'read':
      return `read:${action?.kind === 'read' ? `${action.paths.length} file${action.paths.length === 1 ? '' : 's'}` : sig.slice(5, 17)}`;
    case 'done':
      return 'done';
    case 'intent':
      return 'intent:unresolved';
    case 'fail:generator':
      return 'fail:generator';
    case 'fail':
      return outcome?.status === 'executed' && outcome.exec ? `fail:exit ${outcome.exec.exitCode ?? 'null'}` : `fail:${sig.slice(5, 17)}`;
  }
}

/** TUI-DESIGN §7.3: fold a committed step's `loopSignatures` into the counts (cumulative since the last reset). */
export function foldLoopStep(fold: LoopFold, record: Pick<StepRecord, 'proposal' | 'outcome' | 'loopSignatures'>, g: GlyphSet = GLYPHS.unicode): LoopFold {
  if (record.loopSignatures.length === 0) return fold;
  const counts = { ...fold.counts };
  const labels = { ...fold.labels };
  for (const sig of record.loopSignatures) {
    counts[sig] = (counts[sig] ?? 0) + 1;
    labels[sig] = describeSignature(sig, record, g);
  }
  return { ...fold, counts, labels };
}

/** TUI-DESIGN §7.3: a `replan` event — counts reset, the directive becomes the banner's `replan n/max sN move p imp`. */
export function foldLoopReplan(fold: LoopFold, step: number, directive: ReplanDirective): LoopFold {
  const replans = fold.replans + 1;
  return { ...fold, counts: {}, labels: {}, replans, replan: { n: replans, max: fold.maxReplans, step, move: directive.move, p: directive.probability, impossible: directive.taskImpossible } };
}

/** TUI-DESIGN §7.3: `steer:applied` — the detector's counts reset, and so does the banner's; the replan directive stays until the plan drops it. */
export function foldLoopSteer(fold: LoopFold): LoopFold {
  return { ...fold, counts: {}, labels: {} };
}

/** TUI-DESIGN §15 item 20 (`plan` row): the replan directive leaves the banner once the plan's `harnessProblems` hold no replan any more. */
export function foldLoopPlan(fold: LoopFold, hasReplanProblem: boolean): LoopFold {
  return hasReplanProblem || fold.replan === null ? fold : { ...fold, replan: null };
}

/** The banner view of a fold: the signature with the highest count (ties → first seen), or null when nothing shows. */
export function loopView(fold: LoopFold): LoopBannerView | null {
  let bestSig: string | null = null;
  let best = 0;
  for (const [sig, n] of Object.entries(fold.counts)) {
    if (n > best) {
      best = n;
      bestSig = sig;
    }
  }
  if (best < 2 && fold.replan === null) return null;
  return { signature: bestSig !== null ? (fold.labels[bestSig] ?? bestSig) : '', count: best, max: LOOP_TRIP_COUNT, replan: fold.replan };
}

/** `.61` for probabilities (the round-2 banner's `p .61 imp .12`; kept for callers that print the short form). */
export function shortP(x: number): string {
  if (!Number.isFinite(x)) return 'nan';
  const s = Math.max(0, Math.min(1, x)).toFixed(2);
  return s.startsWith('0') ? s.slice(1) : s;
}

/** TUI-DESIGN-3 §5.1 rule 6: probabilities with two decimals (`0.62`). */
export function bannerP(x: number): string {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)).toFixed(2) : 'nan';
}

/**
 * TUI-DESIGN-3 §5.1 rule 12: the one-row banner — `loop · <signature> repeated 2 of 3` · `loop · replan 1 of 5 · s7 gather_context
 * (p 0.62 · impossible 0.20)` (both segments when both apply, ` · ` between them; `-` under `--ascii`) — or null when neither
 * a count ≥ 2 nor a replan is active.
 */
export function bannerRow(view: LoopBannerView | null, columns: number, g: GlyphSet = GLYPHS.unicode): string | null {
  if (view === null || columns <= 0) return null;
  const sep = ` ${g.dot} `;
  const parts: string[] = [];
  if (view.count >= 2) parts.push(`${oneLineCells(view.signature)} repeated ${view.count} of ${view.max}`);
  if (view.replan) {
    const r = view.replan;
    parts.push(`replan ${r.n} of ${r.max}${sep}s${r.step} ${r.move} (p ${bannerP(r.p)}${sep}impossible ${bannerP(r.impossible)})`);
  }
  if (parts.length === 0) return null;
  return truncateCells(`loop${sep}${parts.join(sep)}`, columns, g);
}
