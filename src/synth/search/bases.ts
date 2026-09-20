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
 * nothing here needs a field on SearchMemory. That state lives as long as the memory; the
 * remembered partials also survive a park (`forgetHeld`) and a checkpoint (`persistPartials` /
 * `restorePartials`, ≤ MAX_PERSISTED_PARTIALS_PER_GOAL per goal), because they are the input of
 * `pairsOfPartials` — the ladder `account` run of jev-only-ladder-4-analysis.md §1.2 found both
 * gold half-fixes and dropped them with the goal's park. Everything else is rebuilt (§5.2: lost
 * state costs test time, never a wrong commit).
 */
import { createHash } from 'node:crypto';

import type { Json, StageName } from '../../core/types.js';
import { analyse, blockAt, scopeAt, unifiedDiff } from '../py/index.js';
import type { AppliedCandidate, Candidate, CandidateSourceName, JevAsk, LineEdit, Site, SourceFile, TestRunSummary } from '../types.js';
import { applyCandidate, judgeProgress, progress } from '../verify/index.js';
import { wasTried } from './memory.js';
import type { SearchMemory } from './memory.js';
import type { Base, Decision, Goal, Phase, VerifyOutcome } from './types.js';

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
/**
 * Partials written into the checkpoint per goal (`persistPartials`), most tests covered first.
 * `setSynthState` drops a state over SYNTH_STATE_MAX_BYTES (64 KB, loop/engine.ts) and the
 * `tried` hashes alone may take 45 KB (memory.ts TRIED_PERSIST_MAX); one record is ≈ 250 B, so
 * four per goal over a three-goal ladder task costs ≈ 3 KB. Four is also all `pairsOfPartials`
 * needs on the measured shape (ladder `account`: two complementary partials, one per hunk).
 */
export const MAX_PERSISTED_PARTIALS_PER_GOAL = 4;
/** A persisted partial's edit text (and each extra edit) is bounded here; a longer edit is not persisted. */
export const PERSISTED_EDIT_MAX_CHARS = 400;
const PERSISTED_EXTRA_EDITS_MAX = 4;

// ---------------------------------------------------------------------------------------
// Memory slice
// ---------------------------------------------------------------------------------------

export interface RememberedPartial {
  goalId: string;
  outcome: VerifyOutcome;
}

/**
 * A test-passing candidate the guard holds within the step (guard.ts §2.6 hold rules): the
 * all-overfit signature's smallest edit, or a lone passer whose code-computed structural signals
 * Q16 confirmed as doubtful (p < LONE_PASSER_HOLD_MAX_NOUL). Committed at step end, or replaced
 * by the arbitration when a later batch adds a passer.
 */
export interface HeldPasser extends RememberedPartial {
  /** the phase the passer was held in (for the transcript; the hold lasts to the step end or the budget reserve) */
  phase?: Phase;
  /** the structural signals behind the hold (empty for the all-overfit signature) */
  signals?: string[];
  /** the Q16 `general` p Jev gave the lone passer, when asked */
  noul?: number;
}

/** A lone passer waiting for the rest of its site's seed sources in SIEVE mode (guard.ts rule (a)). */
export interface PendingPasser extends RememberedPartial {
  /** `siteKeyOf` of the passer's site: the batch is over when a decision arrives from elsewhere or from the site's last seed source */
  siteKey: string;
  phase: Phase;
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
  suspect: HeldPasser | null;
  /** a lone passer of a SIEVE batch, held until its site's other seed sources ran (guard.ts rule (a)) */
  pending: PendingPasser | null;
  /** arbitration runner-ups of the last arbitrated goal */
  fallbacks: RememberedFallbacks | null;
}

const STATE = new WeakMap<BasesMemory, GuardState>();

/** The guard/bases state of `mem`, created on first use. */
export function guardState(mem: BasesMemory): GuardState {
  let st = STATE.get(mem);
  if (st === undefined) {
    st = { partials: [], closeness: new Map(), suspect: null, pending: null, fallbacks: null };
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

/** Forget the partials, held passers (suspect, pending), fallbacks and tie-break cache of a goal (after its commit). */
export function forgetGoal(mem: BasesMemory, goal: Goal): void {
  forgetHeld(mem, goal);
  const st = guardState(mem);
  st.partials = st.partials.filter((p) => p.goalId !== goal.id);
}

/**
 * The park-time form of `forgetGoal`: the step-scoped state goes (held passers, fallbacks, the
 * improved base and its tie-break cache — a base another goal's search would otherwise run every
 * candidate on), the remembered partials STAY. They are the input of `pairsOfPartials`, and the
 * ladder `account` run lost both gold half-fixes to a `forgetGoal` on park two seconds after they
 * were found (experiments/results/jev-only-ladder-4-analysis.md §1.2): the pairing hatch had no
 * budget left in that step, and the next search of the goal started from nothing. A held passer
 * is decided by the caller before this (index.ts and subgoal.ts commit it), never dropped here.
 */
export function forgetHeld(mem: BasesMemory, goal: Pick<Goal, 'id'>): void {
  const st = guardState(mem);
  if (st.suspect !== null && st.suspect.goalId === goal.id) st.suspect = null;
  if (st.pending !== null && st.pending.goalId === goal.id) st.pending = null;
  if (st.fallbacks !== null && st.fallbacks.goalId === goal.id) st.fallbacks = null;
  const b = mem.bases.find((x) => x.origin === 'improved' && x.fromGoal === goal.id);
  if (b !== undefined) {
    mem.bases = mem.bases.filter((x) => x.id !== b.id);
    st.closeness.delete(b.id);
  }
}

/** The committed-base partials remembered for `goal` (what `pairsOfPartials` reads). */
export function partialsOf(mem: BasesMemory, goal: Pick<Goal, 'id'>): VerifyOutcome[] {
  return guardState(mem).partials.filter((p) => p.goalId === goal.id && p.outcome.job.base.origin === 'committed' && isPartial(p.outcome)).map((p) => p.outcome);
}

/**
 * The pairs of `pairsOfPartials` whose diff on the committed workspace has not been run yet: two
 * complementary partials (disjoint newly-passing sets at different sites — together they cover
 * more of the goal's tests than either alone) the tests have not been asked about as one edit.
 * Non-empty means the goal holds untested progress: the controller keeps such a goal open and
 * the search runs these before any other batch once the step's budget is inside the pairs
 * reserve (subgoal.ts). A pair that no longer applies (the workspace changed under a partial)
 * counts as tried.
 */
export function freshPairsOfPartials(mem: BasesMemory & Pick<SearchMemory, 'tried'>, goal: Goal, max: number = MAX_PARTIAL_PAIRS): Candidate[] {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  if (committed === undefined) return [];
  const out: Candidate[] = [];
  for (const c of pairsOfPartials(mem, goal)) {
    if (out.length >= max) break;
    try {
      if (!wasTried(mem, applyCandidate(c, committed.files).diff)) out.push(c);
    } catch {
      // a stale site: nothing to run
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Persisted partials (SynthesisContext.synthState, beside memory.ts's PersistedSearchState)
// ---------------------------------------------------------------------------------------

/**
 * A remembered partial as the checkpoint carries it: the edit (site position and text, extra
 * edits), the tests it newly passed and the passed count of its run. Enough to rebuild a
 * committed-base `VerifyOutcome` for `pairsOfPartials` on resume (`restorePartials`); the test
 * summaries and the applied files are not kept (they are recomputed, and would not fit).
 */
export interface PersistedPartial {
  goalId: string;
  path: string;
  line: number;
  kind: 'replace' | 'insert';
  text: string;
  indent: string;
  source: CandidateSourceName;
  op: string;
  extraEdits?: { path: string; line: number; kind: LineEdit['kind']; text?: string }[];
  newlyPassing: string[];
  passed: number;
}

/** The key the controller writes the records under, beside memory.ts's fields. */
export const PERSISTED_PARTIALS_KEY = 'partials';

/**
 * The committed-base partials of every goal that is not fixed, ≤ `perGoal` per goal (most
 * newly-passing tests first, then the smaller edit); edits over PERSISTED_EDIT_MAX_CHARS or with
 * more than a few extra edits are left out. Deterministic; JSON-safe by construction.
 */
export function persistPartials(mem: BasesMemory, goals: readonly Pick<Goal, 'id' | 'status'>[], perGoal: number = MAX_PERSISTED_PARTIALS_PER_GOAL): PersistedPartial[] {
  const out: PersistedPartial[] = [];
  for (const goal of goals) {
    if (goal.status === 'fixed') continue;
    const ours = partialsOf(mem, goal);
    ours.sort((a, b) => b.progress.newlyPassing.length - a.progress.newlyPassing.length || editSize(a.applied.candidate) - editSize(b.applied.candidate) || a.applied.candidate.id.localeCompare(b.applied.candidate.id));
    let kept = 0;
    for (const o of ours) {
      if (kept >= perGoal) break;
      const c = o.applied.candidate;
      const extra = c.extraEdits ?? [];
      if (c.text.length > PERSISTED_EDIT_MAX_CHARS || extra.length > PERSISTED_EXTRA_EDITS_MAX || extra.some((e) => (e.text ?? '').length > PERSISTED_EDIT_MAX_CHARS)) continue;
      const rec: PersistedPartial = { goalId: goal.id, path: c.site.file.path, line: c.site.line, kind: c.site.kind, text: c.text, indent: c.site.indent, source: c.source, op: c.op, newlyPassing: [...o.progress.newlyPassing], passed: outcomeSummary(o).passed };
      if (extra.length > 0) rec.extraEdits = extra.map((e) => (e.text === undefined ? { path: e.path, line: e.line, kind: e.kind } : { path: e.path, line: e.line, kind: e.kind, text: e.text }));
      out.push(rec);
      kept += 1;
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const SOURCE_NAMES: readonly string[] = ['mutation', 'template', 'donor', 'token_beam', 'test_value', 'history', 'composite'];

function isSourceName(v: unknown): v is CandidateSourceName {
  return typeof v === 'string' && SOURCE_NAMES.includes(v);
}

function isEditKind(v: unknown): v is LineEdit['kind'] {
  return v === 'replace' || v === 'insert' || v === 'delete';
}

/** The `partials` records of a checkpoint state (an older checkpoint has none; a malformed record is skipped). */
export function partialsFromPersisted(state: Json | null): PersistedPartial[] {
  if (!isRecord(state)) return [];
  const raw = state[PERSISTED_PARTIALS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: PersistedPartial[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const { goalId, path, line, kind, text, indent, source, op, newlyPassing, passed, extraEdits } = r;
    if (typeof goalId !== 'string' || typeof path !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
    if ((kind !== 'replace' && kind !== 'insert') || typeof text !== 'string' || typeof op !== 'string' || !isStringArray(newlyPassing) || typeof passed !== 'number') continue;
    if (!isSourceName(source)) continue;
    const rec: PersistedPartial = { goalId, path, line, kind, text, indent: typeof indent === 'string' ? indent : '', source, op, newlyPassing, passed };
    if (Array.isArray(extraEdits)) {
      const edits: NonNullable<PersistedPartial['extraEdits']> = [];
      for (const e of extraEdits) {
        if (!isRecord(e)) continue;
        const ePath = e['path'];
        const eLine = e['line'];
        const eKind = e['kind'];
        const eText = e['text'];
        if (typeof ePath !== 'string' || typeof eLine !== 'number' || !isEditKind(eKind)) continue;
        edits.push(typeof eText === 'string' ? { path: ePath, line: eLine, kind: eKind, text: eText } : { path: ePath, line: eLine, kind: eKind });
      }
      if (edits.length > 0) rec.extraEdits = edits;
    }
    out.push(rec);
  }
  return out;
}

/** The site of a persisted partial on the committed workspace; null when the file is gone or the line is no longer code. */
function siteOfPersisted(file: SourceFile, rec: PersistedPartial): Site | null {
  const lines = file.mod.lines;
  const blockOf = (line: number): Site['block'] => {
    const b = blockAt(file.mod, line);
    return b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine };
  };
  if (rec.kind === 'replace') {
    const current = lines[rec.line - 1];
    if (current === undefined || current.trim() === '' || current.trim().startsWith('#')) return null;
    return { file, line: rec.line, kind: 'replace', currentLine: current, indent: /^\s*/.exec(current)?.[0] ?? '', block: blockOf(rec.line), scope: scopeAt(file.mod, rec.line), evidence: { notes: ['restored partial'] } };
  }
  if (rec.line > lines.length + 1) return null;
  const above = Math.max(1, rec.line - 1);
  return { file, line: rec.line, kind: 'insert', currentLine: '', indent: rec.indent, block: blockOf(above), scope: scopeAt(file.mod, above), evidence: { notes: ['restored partial'] } };
}

/**
 * Re-install persisted partials on resume as committed-base outcomes: only for goals the ledger
 * still holds unfixed, only where the edit still applies to the committed files and the tests it
 * newly passed still fail on the baseline (else the record is stale). The progress is rebuilt from
 * the baseline arithmetically (the tests it passed pass, nothing else moves); it is a partial by
 * construction and its pair is verified by the tests like any candidate. Returns how many were
 * restored.
 */
export function restorePartials(mem: BasesMemory, records: readonly PersistedPartial[], goals: readonly Pick<Goal, 'id' | 'status'>[]): number {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  if (committed === undefined || records.length === 0) return 0;
  const live = new Set(goals.filter((g) => g.status !== 'fixed').map((g) => g.id));
  const st = guardState(mem);
  const seen = new Set(st.partials.map((p) => sha12(p.outcome.applied.diff)));
  const before = committed.summary;
  const stillFailing = new Set(before.failing);
  let restored = 0;
  for (const rec of records) {
    if (!live.has(rec.goalId)) continue;
    const file = committed.files.get(rec.path);
    if (file === undefined) continue;
    const site = siteOfPersisted(file, rec);
    if (site === null) continue;
    const newlyPassing = rec.newlyPassing.filter((t) => stillFailing.has(t));
    if (newlyPassing.length === 0 || newlyPassing.length >= before.failing.length) continue;
    const candidate: Candidate = { id: `restored:${sha12(`${rec.path}:${rec.line}:${rec.kind}:${rec.text}`)}`, site, text: rec.text, source: rec.source, op: rec.op };
    if (rec.extraEdits !== undefined) candidate.extraEdits = rec.extraEdits.map((e): LineEdit => (e.text === undefined ? { path: e.path, line: e.line, kind: e.kind } : { path: e.path, line: e.line, kind: e.kind, text: e.text }));
    let applied: AppliedCandidate;
    try {
      applied = applyCandidate(candidate, committed.files);
    } catch {
      continue;
    }
    const h = sha12(applied.diff);
    if (seen.has(h)) continue;
    seen.add(h);
    const passing = new Set(newlyPassing);
    const after: TestRunSummary = {
      ...before,
      passed: before.passed + newlyPassing.length,
      failed: Math.max(0, before.failed - newlyPassing.length),
      failing: before.failing.filter((t) => !passing.has(t)),
      passing: [...before.passing, ...newlyPassing],
      failures: before.failures.filter((f) => !passing.has(f.testId)),
      timedOut: false,
    };
    const p = progress(before, after);
    if (!p.improved || p.regressed || p.allPass) continue;
    const outcome: VerifyOutcome = { job: { candidate, base: committed, p: 0, sourcePrior: 0, key: [before.passed, 0, 0] }, applied, subset: after, progress: p, status: 'partial' };
    st.partials.push({ goalId: rec.goalId, outcome });
    restored += 1;
  }
  if (st.partials.length > MAX_PARTIALS_REMEMBERED) st.partials.splice(0, st.partials.length - MAX_PARTIALS_REMEMBERED);
  return restored;
}
