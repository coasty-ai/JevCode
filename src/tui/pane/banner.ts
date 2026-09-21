/**
 * Loop banner (TUI-DESIGN §7.3, A45): one row, present only while a signature count ≥ 2 or a
 * replan directive is active — `loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12`.
 * Counts are folded from `step:end.record.loopSignatures`, reset on `replan` and `steer:applied`.
 * Pure; the row is ≤ `columns`.
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

/** `.61` for probabilities in the banner (§24 `p .61 imp .12`). */
export function shortP(x: number): string {
  if (!Number.isFinite(x)) return 'nan';
  const s = Math.max(0, Math.min(1, x)).toFixed(2);
  return s.startsWith('0') ? s.slice(1) : s;
}

/** TUI-DESIGN §7.3 / §24: the one-row banner — `loop  <signature>  x2/3   replan 1/5 s6 <move> p .61 imp .12` — or null when neither a count ≥ 2 nor a replan is active. */
export function bannerRow(view: LoopBannerView | null, columns: number, g: GlyphSet = GLYPHS.unicode): string | null {
  if (view === null || columns <= 0) return null;
  const parts: string[] = [];
  if (view.count >= 2) parts.push(`${oneLineCells(view.signature)}  x${view.count}/${view.max}`);
  if (view.replan) {
    const r = view.replan;
    parts.push(`replan ${r.n}/${r.max} s${r.step} ${r.move} p ${shortP(r.p)} imp ${shortP(r.impossible)}`);
  }
  if (parts.length === 0) return null;
  return truncateCells(`loop  ${parts.join('   ')}`, columns, g);
}
