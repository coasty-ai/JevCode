/**
 * The beam of bases (docs/JEV-ONLY-DESIGN.md §2.6, §4.4): the committed workspace plus at most one
 * 'improved' partial, held rather than committed so the search never walks into the greedy trap the
 * prototype fell into three times (`kth`, `sqrt`, `topological_ordering`; prototype-baseline.md).
 *
 *   - `holdBestPartial`: ≤ 1 improved base, replaced only by a partial that passes STRICTLY more
 *     tests; ties are broken by the Q17 `closeness` Score's expected level (the one Jev question
 *     here, a consistency check that never gates anything: probe-progress-judgment.md 230/240).
 *   - `pairsOfPartials`: contrarian source 5: two partials at different sites that fix disjoint
 *     test subsets become one composite candidate (≤ 10 pairs, tests decide).
 *   - `commitPartial`: at exhaustion the held partial is committed (its regression run was clean by
 *     construction) and the goal is re-clustered from the new baseline next step.
 *
 * Memory: these modules read and write `mem.bases` (the design's `SearchMemory.bases`) and keep
 * their own bookkeeping (remembered partials, the closeness cache, the suspect, the fallbacks) in a
 * WeakMap keyed by the memory object (`guardState`), so any `{ bases: Base[] }` works unchanged and
 * nothing here needs a field on SearchMemory. That state lives as long as the memory and is not
 * persisted (§5.2: lost state costs test time, never a wrong commit).
 */
import { createHash } from 'node:crypto';

import type { StageName } from '../../core/types.js';
import { analyse, unifiedDiff } from '../py/index.js';
import type { AppliedCandidate, Candidate, JevAsk, LineEdit, SourceFile, TestRunSummary } from '../types.js';
import { judgeProgress, progress } from '../verify/index.js';
import type { Base, Decision, Goal, VerifyOutcome } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement or design rule behind it)
// ---------------------------------------------------------------------------------------

/** §6.1 `Base.depth`: at most 3 edits above the committed workspace; deeper chains are committed one at a time. */
export const MAX_BASE_DEPTH = 3;
/** §4.3: pairs of partials cost ≤ 10 goal-subset runs per step. */
export const MAX_PARTIAL_PAIRS = 10;
/**
 * Partials remembered per goal for pairing. The SEEDS sieve at QuixBugs scale sees a handful of
 * partials per site (`nPartial` 0–6 per line in contrarian-exhaustive.truth.jsonl); 40 covers ≤ 6
 * sites with room and bounds the O(n²) pairing.
 */
export const MAX_PARTIALS_REMEMBERED = 40;
/**
 * Q17 requests spent on one `holdBestPartial` call when pass counts tie: the incumbent (once,
 * cached) plus the tied challengers. Ties are rare (the count is arithmetic); this keeps a
 * pathological batch from spending the step's Jev budget on tie-breaks.
 */
export const MAX_CLOSENESS_REQUESTS = 4;

// ---------------------------------------------------------------------------------------
// Memory slice
// ---------------------------------------------------------------------------------------

export interface RememberedPartial {
  goalId: string;
  outcome: VerifyOutcome;
}

/** Arbitration runner-ups of one goal (guard.ts), for later steps if the judge rejects the pick. */
export interface RememberedFallbacks {
  goalId: string;
  outcomes: VerifyOutcome[];
}

/** What bases.ts and guard.ts need from the run's SearchMemory: the beam of bases. */
export interface BasesMemory {
  /** committed workspace first, then at most one 'improved' base */
  bases: Base[];
}

/** Same requirement; the name marks functions that also touch the guard's bookkeeping. */
export type GuardMemory = BasesMemory;

/** Per-memory bookkeeping of the guard and the bases, kept beside the memory (see the header). */
export interface GuardState {
  /** partials seen this run per goal (source of `pairsOfPartials`), bounded */
  partials: RememberedPartial[];
  /** base id → Q17 closeness E[level], so an incumbent is judged once */
  closeness: Map<string, number>;
  /**
   * A test-passing candidate flagged by the suspect rule, committed at step end if nothing better.
   * Scoped to its goal so a later goal's step end never commits another goal's flagged passer.
   */
  suspect: RememberedPartial | null;
  /** arbitration runner-ups of the last arbitrated goal */
  fallbacks: RememberedFallbacks | null;
}

const STATE = new WeakMap<BasesMemory, GuardState>();

/** The guard/bases state of `mem`, created on first use. */
export function guardState(mem: BasesMemory): GuardState {
  let st = STATE.get(mem);
  if (st === undefined) {
    st = { partials: [], closeness: new Map(), suspect: null, fallbacks: null };
    STATE.set(mem, st);
  }
  return st;
}

/** A minimal memory for tests and for callers that have no SearchMemory yet. */
export function createGuardMemory(committed: Base): GuardMemory {
  return { bases: [committed] };
}

export class BasesError extends Error {
  constructor(message: string) {
    super(`BasesError: ${message}`);
    this.name = 'BasesError';
  }
}

// ---------------------------------------------------------------------------------------
// Helpers shared with guard.ts
// ---------------------------------------------------------------------------------------

export function committedBase(mem: BasesMemory): Base {
  const b = mem.bases.find((x) => x.origin === 'committed');
  if (b === undefined) throw new BasesError('memory has no committed base');
  return b;
}

export function improvedBase(mem: BasesMemory): Base | undefined {
  return mem.bases.find((x) => x.origin === 'improved');
}

/** The improved base held for `goal`, if any. */
export function improvedBaseFor(mem: BasesMemory, goal: Goal): Base | undefined {
  const b = improvedBase(mem);
  return b !== undefined && b.fromGoal === goal.id ? b : undefined;
}

/** The summary a partial is judged on: the full-suite run when it exists, else the goal-subset run. */
export function outcomeSummary(o: VerifyOutcome): TestRunSummary {
  return o.full ?? o.subset;
}

/** `file:line:kind` — two candidates at the same site are alternatives, not a pair. */
export function siteKeyOf(c: Candidate): string {
  return `${c.site.file.path}:${c.site.line}:${c.site.kind}`;
}

export function sha12(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * A partial in the design's sense: strictly more tests pass, nothing that passed now fails, and
 * the goal is not finished. Timed-out and regressed runs are never held (§4.1).
 */
export function isPartial(o: VerifyOutcome): boolean {
  if (o.status === 'timeout' || o.status === 'regressed' || o.status === 'apply_failed') return false;
  const s = outcomeSummary(o);
  return o.progress.improved && !o.progress.regressed && !o.progress.allPass && !s.timedOut;
}

/**
 * The edit as a patch of the COMMITTED workspace. A candidate run on an 'improved' base carries a
 * diff relative to that base's files, which the engine's `git apply` would refuse against the real
 * workspace (the held partial is not applied there, §4.2). So every commit, whatever base found it,
 * is re-expressed against the committed files: the base's own edits plus the candidate's, one
 * unified diff. On the committed base the outcome's own AppliedCandidate is returned unchanged.
 */
export function appliedOnCommitted(mem: BasesMemory, o: VerifyOutcome): AppliedCandidate {
  const base = o.job.base;
  if (base.origin === 'committed') return o.applied;
  const committed = committedBase(mem);
  const paths = new Set<string>(o.applied.files.map((f) => f.path));
  for (const [path, f] of base.files) if (committed.files.get(path)?.src !== f.src) paths.add(path);
  const files: { path: string; before: string; after: string }[] = [];
  let diff = '';
  for (const path of [...paths].sort()) {
    const before = committed.files.get(path)?.src ?? '';
    const after = o.applied.files.find((f) => f.path === path)?.after ?? base.files.get(path)?.src ?? before;
    if (before === after) continue;
    files.push({ path, before, after });
    const d = unifiedDiff(path, before, after);
    if (d !== '') diff += d.endsWith('\n') ? d : `${d}\n`;
  }
  return { candidate: o.applied.candidate, files, diff };
}

// ---------------------------------------------------------------------------------------
// holdBestPartial
// ---------------------------------------------------------------------------------------

export interface HoldOptions {
  /** Jev, for the Q17 tie-break only; without it ties keep the incumbent */
  ask?: JevAsk;
  stage?: StageName;
  /** e.g. "the Python function `gcd`" for the Q17 state */
  subject?: string;
}

export interface HoldResult {
  /** the improved base after the call (unchanged incumbent, the new one, or null when nothing is held) */
  held: Base | null;
  /** true when a new base was installed (first hold or replacement) */
  replaced: boolean;
  requests: number;
}

/** Rebuild the file map of a base after `o` was applied on top of `o.job.base`. */
function filesAfter(o: VerifyOutcome): ReadonlyMap<string, SourceFile> {
  const files = new Map<string, SourceFile>(o.job.base.files);
  for (const f of o.applied.files) files.set(f.path, { path: f.path, src: f.after, mod: analyse(f.after) });
  return files;
}

/** The base a partial becomes; its `candidate` is the cumulative edit over the committed workspace (what `commitPartial` proposes). */
function baseFromPartial(mem: BasesMemory, o: VerifyOutcome, goal: Goal): Base | null {
  let files: ReadonlyMap<string, SourceFile>;
  try {
    files = filesAfter(o);
  } catch {
    // The analyser refusing the text means we cannot enumerate from this base; it stays a run result only.
    return null;
  }
  const candidate = appliedOnCommitted(mem, o);
  return {
    id: `improved-${goal.id}-${sha12(candidate.diff)}`,
    origin: 'improved',
    fromGoal: goal.id,
    files,
    summary: outcomeSummary(o),
    candidate,
    depth: o.job.base.depth + 1,
  };
}

function remember(mem: BasesMemory, goal: Goal, partials: readonly VerifyOutcome[]): void {
  const st = guardState(mem);
  const seen = new Set(st.partials.map((p) => p.outcome.applied.candidate.id));
  for (const o of partials) {
    const id = o.applied.candidate.id;
    if (seen.has(id)) continue;
    seen.add(id);
    st.partials.push({ goalId: goal.id, outcome: o });
  }
  if (st.partials.length > MAX_PARTIALS_REMEMBERED) st.partials.splice(0, st.partials.length - MAX_PARTIALS_REMEMBERED);
}

/**
 * Q17 `closeness` E[level] of `after` relative to the committed workspace; cached per base id.
 * Returns null when no Jev is available or the Score was not answered.
 */
async function closenessOf(mem: BasesMemory, id: string, after: TestRunSummary, opts: HoldOptions, counter: { requests: number }): Promise<number | null> {
  const cached = guardState(mem).closeness.get(id);
  if (cached !== undefined) return cached;
  if (opts.ask === undefined || counter.requests >= MAX_CLOSENESS_REQUESTS) return null;
  const before = committedBase(mem).summary;
  const judgeOpts: { stage: StageName; subject?: string } = { stage: opts.stage ?? 'propose' };
  if (opts.subject !== undefined) judgeOpts.subject = opts.subject;
  const j = await judgeProgress(progress(before, after), opts.ask, judgeOpts);
  counter.requests += j.requests;
  if (j.closenessExpected === null) return null;
  guardState(mem).closeness.set(id, j.closenessExpected);
  return j.closenessExpected;
}

/**
 * Hold at most one improved base. Replacement rule (§4.4): strictly more passed tests wins; on a
 * tie the higher Q17 closeness E[level] wins (strictly), otherwise the incumbent stays. A partial
 * built on a base already at MAX_BASE_DEPTH is not held. Every partial is remembered for
 * `pairsOfPartials` whether or not it becomes the base.
 */
export async function holdBestPartial(mem: BasesMemory, partials: readonly VerifyOutcome[], goal: Goal, opts: HoldOptions = {}): Promise<HoldResult> {
  const eligible = partials.filter((o) => isPartial(o) && o.job.base.depth < MAX_BASE_DEPTH);
  remember(mem, goal, eligible);
  const counter = { requests: 0 };
  const incumbent = improvedBase(mem);
  if (eligible.length === 0) return { held: incumbent ?? null, replaced: false, requests: 0 };

  // Best challengers by passed count (arithmetic, code); Q17 only among exact ties.
  const topPassed = Math.max(...eligible.map((o) => outcomeSummary(o).passed));
  const tied = eligible.filter((o) => outcomeSummary(o).passed === topPassed);
  let challenger = tied[0];
  if (challenger === undefined) return { held: incumbent ?? null, replaced: false, requests: 0 };
  if (tied.length > 1 && opts.ask !== undefined) {
    let bestE = -Infinity;
    for (const o of tied) {
      const e = await closenessOf(mem, `partial-${sha12(o.applied.diff)}`, outcomeSummary(o), opts, counter);
      if (e !== null && e > bestE) {
        bestE = e;
        challenger = o;
      }
    }
  }

  const passed = outcomeSummary(challenger).passed;
  if (incumbent !== undefined) {
    const incumbentPassed = incumbent.summary.passed;
    if (passed < incumbentPassed) return { held: incumbent, replaced: false, requests: counter.requests };
    if (passed === incumbentPassed) {
      const eNew = await closenessOf(mem, `partial-${sha12(challenger.applied.diff)}`, outcomeSummary(challenger), opts, counter);
      const eOld = await closenessOf(mem, incumbent.id, incumbent.summary, opts, counter);
      // Only a strictly closer challenger displaces the incumbent; unknown closeness keeps it.
      if (eNew === null || eOld === null || eNew <= eOld) return { held: incumbent, replaced: false, requests: counter.requests };
    }
  }
  const next = baseFromPartial(mem, challenger, goal);
  if (next === null) return { held: incumbent ?? null, replaced: false, requests: counter.requests };
  // Carry the challenger's closeness (judged under its partial id) over to its base id.
  const e = guardState(mem).closeness.get(`partial-${sha12(challenger.applied.diff)}`);
  if (e !== undefined) guardState(mem).closeness.set(next.id, e);
  mem.bases = [...mem.bases.filter((b) => b.origin !== 'improved'), next];
  return { held: next, replaced: true, requests: counter.requests };
}

// ---------------------------------------------------------------------------------------
// pairsOfPartials
// ---------------------------------------------------------------------------------------

function touchedLines(c: Candidate): Set<string> {
  const out = new Set<string>([`${c.site.file.path}:${c.site.line}`]);
  for (const e of c.extraEdits ?? []) out.add(`${e.path}:${e.line}`);
  return out;
}

function disjoint<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/** Token count of the edit, the code-only "size" used to order pairs when their coverage ties. */
function editSize(c: Candidate): number {
  return c.text.split(/\s+/).filter(Boolean).length + (c.extraEdits ?? []).reduce((n, e) => n + (e.text ?? '').split(/\s+/).filter(Boolean).length, 0);
}

/**
 * Composite candidates from two partials at different sites whose newly passing tests are
 * disjoint (each fixes a behaviour the other does not). Both must have been run on the committed
 * base so their line numbers refer to the same source (applyCandidate applies bottom-up in
 * original coordinates, so no shifting is needed). Ordered by tests covered, then edit size;
 * ≤ MAX_PARTIAL_PAIRS. The pair is a candidate like any other: tests decide.
 */
export function pairsOfPartials(mem: BasesMemory, goal: Goal): Candidate[] {
  const ours = guardState(mem).partials.filter((p) => p.goalId === goal.id && p.outcome.job.base.origin === 'committed' && isPartial(p.outcome)).map((p) => p.outcome);
  const scored: { cand: Candidate; covered: number; size: number }[] = [];
  for (let i = 0; i < ours.length; i++) {
    for (let j = i + 1; j < ours.length; j++) {
      const a = ours[i];
      const b = ours[j];
      if (a === undefined || b === undefined) continue;
      const ca = a.applied.candidate;
      const cb = b.applied.candidate;
      if (siteKeyOf(ca) === siteKeyOf(cb)) continue;
      if (!disjoint(touchedLines(ca), touchedLines(cb))) continue;
      const pa = new Set(a.progress.newlyPassing);
      const pb = new Set(b.progress.newlyPassing);
      if (pa.size === 0 || pb.size === 0 || !disjoint(pa, pb)) continue;
      const extra: LineEdit[] = [...(ca.extraEdits ?? []), { path: cb.site.file.path, line: cb.site.line, kind: cb.site.kind, text: cb.text }, ...(cb.extraEdits ?? [])];
      const cand: Candidate = { id: `pair:${ca.id}+${cb.id}`, site: ca.site, text: ca.text, source: 'composite', op: 'pair_of_partials', extraEdits: extra };
      scored.push({ cand, covered: pa.size + pb.size, size: editSize(ca) + editSize(cb) });
    }
  }
  scored.sort((x, y) => y.covered - x.covered || x.size - y.size || x.cand.id.localeCompare(y.cand.id));
  return scored.slice(0, MAX_PARTIAL_PAIRS).map((s) => s.cand);
}

// ---------------------------------------------------------------------------------------
// commitPartial
// ---------------------------------------------------------------------------------------

/**
 * At exhaustion: commit the held partial for `goal` (§2.3 last lines). The base leaves the beam;
 * the caller re-baselines and re-clusters the goal from the new workspace next step. Null when
 * nothing is held for this goal.
 */
export function commitPartial(mem: BasesMemory, goal: Goal): Decision | null {
  const b = improvedBaseFor(mem, goal);
  if (b === undefined || b.candidate === undefined) return null;
  mem.bases = mem.bases.filter((x) => x.id !== b.id);
  // the base leaves the beam here, so its summary travels with the commit as the evidence's `after`
  return { kind: 'commit', applied: b.candidate, allGoalTestsPass: false, note: 'partial', after: b.summary };
}

/** Forget the partials, suspect, fallbacks and tie-break cache of a goal (after its commit or park). */
export function forgetGoal(mem: BasesMemory, goal: Goal): void {
  const st = guardState(mem);
  st.partials = st.partials.filter((p) => p.goalId !== goal.id);
  if (st.suspect !== null && st.suspect.goalId === goal.id) st.suspect = null;
  if (st.fallbacks !== null && st.fallbacks.goalId === goal.id) st.fallbacks = null;
  const b = improvedBaseFor(mem, goal);
  if (b !== undefined) {
    mem.bases = mem.bases.filter((x) => x.id !== b.id);
    st.closeness.delete(b.id);
  }
}
