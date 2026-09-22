/**
 * The synth fast path — route R9 of docs/LLM-LOOP-DESIGN.md §4 — as seen from the synthesizer side.
 *
 * ONE bounded sieve round for a single failing cluster: the facade owns a `jev-only` synthesizer (zero generator calls,
 * zero generator dollars — I6), installs a one-round budget clamp on it (§4.4), runs `synthesize()` once under an abort
 * ceiling, and returns either a cold-confirmed patch proposal or a TYPED refusal. It never applies anything: an accepted
 * result becomes `draft.proposal` at the normal place and goes through the unchanged risk → confirm → coordinate →
 * budget → execute → judge path (I7).
 *
 * Everything here is about *declining cheaply*. The engine-side stage-1 predicate lives in `src/loop/stages/fastpath.ts`
 * and costs nothing; this file holds stage 2 — the clauses that can only be evaluated once the round's own baseline has
 * fitted an oracle — plus the acceptance rule and the round's telemetry.
 *
 * Nothing in this file imports from `src/loop`: the dependency runs loop → synth, never back.
 */
import type { FastPathReason, Proposal, SynthesisContext, WindowEntry } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { decideRunPlan, oracleClass, runsLeft } from './budget.js';
import type { FastPathClamp, RunMemory, SearchDeps } from './index.js';
import { LedgerSieveSynthesizer, framesOfTraceback, mentionedInTask, observeWindow, runMemory } from './index.js';
import { dropMemory } from './memory.js';
import { isTestPath } from './subgoal.js';
import { searchDeps } from '../index.js';
import { summarize } from '../verify/index.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import type { LocalizeResult } from '../types.js';
import type { Goal, GoalSearchTrace, OracleModel, StepBudget } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (§4.3 stage 2, §4.4)
// ---------------------------------------------------------------------------------------

/** §4.3 stage 2: more located sites than this and the round cannot visit them inside one share — the pool is not a cluster. */
export const FASTPATH_MAX_SITES = 16;
/** §4.4: up to 5 for the localiser (Q2–Q6) and one for RS5 arbitration. Zero is legal (code order, no arbitration). */
export const FASTPATH_JEV_MAX = 6;
/** §4.4: the count cap on one round's test runs, against QuixBugs class's own per-STEP 1 500. This is one round. */
export const FASTPATH_TEST_RUNS_MAX = 400;
/** §4.4 bound 2: slack over `wall + reserve` before the defence-in-depth timeout fires. Never the primary bound. */
export const FASTPATH_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------------------
// The round's budget share (computed engine-side, installed here)
// ---------------------------------------------------------------------------------------

/** §4.4: the one-round share the facade installs. Built by `fastPathBudget()` in `src/loop/stages/fastpath.ts`. */
export interface FastPathBudget {
  /** the CANDIDATE phase's wall share; `budget.testWallLeftMs` is clamped to `wallMs + reserveMs` */
  wallMs: number;
  testRuns: number;
  jevRequests: number;
  /**
   * the cold-confirm reserve, held OUTSIDE `wallMs`: a passer without its confirm run is not a result (§4.4). It is
   * INSTALLED, not merely computed — the clamp adds it to `testWallLeftMs` and publishes it as
   * `StepBudget.reserveWallMs`, which stops the sieve dispatching new candidates into it.
   */
  reserveMs: number;
  /** slack before the abort ceiling; `FASTPATH_GRACE_MS` unless a test overrides it */
  graceMs: number;
}

/** The abort ceiling of one round (§4.4 bound 2) — defence in depth over the wall clamp, never the only bound. */
export function fastPathCeilingMs(b: FastPathBudget): number {
  return Math.max(1, Math.floor(b.wallMs + b.reserveMs + b.graceMs));
}

// ---------------------------------------------------------------------------------------
// Stage 2 — the round would be a SIEVE round (§4.3)
// ---------------------------------------------------------------------------------------

/** What stage 2 reads. `poolSize: 0` means "not observed yet" and fits every budget, so the clause is vacuous then. */
export interface FastPathStage2Input {
  oracle: OracleModel;
  /** the CLAMPED step budget — the round's share, not the run's */
  budget: StepBudget;
  /** sites the localiser returned for the cluster */
  sites: number;
  /** candidates enumerated at the first site; 0 = not observed */
  poolSize: number;
  /** the first site's kind, which sets RANK's K */
  siteKind?: 'insert' | 'replace';
}

export interface FastPathStage2Verdict {
  ok: boolean;
  reason: FastPathReason | null;
  runMode: 'SIEVE' | 'RANK';
}

/**
 * §4.3 stage 2: the fast path fires iff the round would be a SIEVE round — the regime line expressed in the code that
 * already draws it (`decideRunPlan` / `poolFitsRunBudget`) rather than a hand-set threshold.
 *
 * Three clauses, in the order they cost anything: the oracle class (free, and the one that refuses every repository
 * shape a second time after T8), the site count, and the run plan at the first site. RANK is ineligible BY
 * CONSTRUCTION, which is why the fast path can never pay the iteration-1 6 960-ranked-against-20-tested failure.
 */
export function fastPathStage2(i: FastPathStage2Input): FastPathStage2Verdict {
  if (oracleClass(i.oracle) !== 'quixbugs_class') return { ok: false, reason: 'oracle_class', runMode: 'RANK' };
  if (runsLeft(i.oracle, i.budget) <= 0) return { ok: false, reason: 'no_wall', runMode: 'SIEVE' };
  if (i.sites <= 0) return { ok: false, reason: 'no_sites', runMode: 'SIEVE' };
  if (i.sites > FASTPATH_MAX_SITES) return { ok: false, reason: 'too_many_sites', runMode: 'SIEVE' };
  const plan = decideRunPlan(i.poolSize, { kind: i.siteKind ?? 'replace' }, i.oracle, i.budget, { sitesLeft: i.sites });
  if (plan.mode !== 'SIEVE') return { ok: false, reason: 'pool_exceeds_run_budget', runMode: 'RANK' };
  return { ok: true, reason: null, runMode: 'SIEVE' };
}

// ---------------------------------------------------------------------------------------
// Acceptance (§4.5)
// ---------------------------------------------------------------------------------------

/**
 * §4.5: the passer was cold-confirmed. `isPlausible()` (guard.ts) already required the goal-subset run AND a
 * non-timed-out full-suite regression run with nothing newly failing before any `commit` decision; this is the facade's
 * own re-check over the only surface a `Proposal` exposes — its code-computed `evidence` — so a synthesizer that ever
 * stops enforcing it cannot quietly put an unconfirmed patch in front of the risk stage.
 *
 * This reduction — "the regression run exists and passed" — is sound ONLY while every lane run is cold, and nothing in
 * a `Proposal`'s evidence says whether the run that produced it was warm-screened. The precondition is therefore
 * enforced where it can be, at stage 1: `fastPathStage1Free` refuses to arm at all when `warmPlaneEnabled()`
 * (`JEVCODE_WARM`, I8), with the named reason `'warm_plane'` and before any wall is spent. A false
 * `confirmedCold: true` is then unreachable rather than merely unlikely.
 */
export function coldConfirmed(p: Proposal): boolean {
  const e = p.evidence;
  if (e === undefined || e.kind !== 'shadow_test_run') return false;
  if (e.after.total <= 0) return false;
  if (e.newlyFailing.length > 0) return false;
  if (e.newlyPassing.length === 0) return false;
  return e.after.passed >= e.before.passed;
}

/** §4.5: what the facade does with the `Proposal` the round returned. Anything but `accept` means the LLM proposes as usual. */
export type FastPathAcceptance =
  | { accept: true }
  | { accept: false; reason: FastPathReason; outcome: 'no_passer' | 'refused'; confirmedCold: boolean };

/**
 * §4.5, all four clauses. A `run` / `read` / `done` proposal is the round saying "no passer" (the controller's own cheap
 * exit); a `patch` without confirmed evidence is a REFUSAL — the guard can drop passers silently (`structuralRejection`,
 * `mutationRefused`, a lone passer held under the Noul floor), and reporting that as `no_passer` would lose the one fact
 * the histogram needs.
 */
export function acceptFastPathProposal(p: Proposal): FastPathAcceptance {
  if (p.action.kind !== 'patch') return { accept: false, reason: 'no_passer', outcome: 'no_passer', confirmedCold: false };
  const e = p.evidence;
  if (e === undefined) return { accept: false, reason: 'held', outcome: 'refused', confirmedCold: false };
  if (e.newlyFailing.length > 0 || e.newlyPassing.length === 0) return { accept: false, reason: 'held', outcome: 'refused', confirmedCold: coldConfirmed(p) };
  if (!coldConfirmed(p)) return { accept: false, reason: 'confirm_timeout', outcome: 'refused', confirmedCold: false };
  return { accept: true };
}

// ---------------------------------------------------------------------------------------
// T6's suspect set (§4.3, pure)
// ---------------------------------------------------------------------------------------

/**
 * §4.3 T6: the CODE-derived suspect set — the traceback's own frames intersected with the workspace's non-test source
 * files, plus the files the task text names. No Jev, no LLM, no task names hard-coded. T6 fires only when this set is
 * exactly one file, which is what "a single-file failing cluster" means.
 */
export function fastPathSuspects(output: string | null, files: readonly string[], task: string): string[] {
  const source = new Set(files.filter((p) => p.endsWith('.py') && !isTestPath(p)));
  const out = new Set<string>();
  for (const f of framesOfTraceback(output)) if (source.has(f.file)) out.add(f.file);
  for (const p of source) if (mentionedInTask(p, task) > 0) out.add(p);
  return [...out].sort();
}

/** §4.3 T10: the `(file, failing-test-id-set)` fingerprint, stable under ordering, that makes a second empty round unreachable. */
export function fastPathFingerprint(file: string, failing: readonly string[]): string {
  return `${file}\u0000${[...new Set(failing)].sort().join('\u0001')}`;
}

/**
 * §4.3 T10: the failing test IDS of the loop's own last run, read out of its output by the same code the oracle uses
 * (`verify/index.ts summarize`), so the fingerprint is the `(file, failing-test-id-set)` the design names.
 *
 * The counts are NOT a substitute. Two structurally different bugs in one file that both print `1 failed, 0 errors`
 * share a counts key, so the second cluster reads as `fingerprint_seen` and a winnable round is never entered; and the
 * same unchanged cluster gets a NEW key whenever a count moves, which defeats the "second empty round is unreachable"
 * guarantee T10 exists for. The synthetic `<test run>` id is dropped: it is what an unparseable run yields, and it
 * would collide every unparseable run with every other. Empty = the output named none; the caller then falls back to
 * the weaker counts key and the record says so.
 */
export function fastPathFailingIds(command: string, output: string | null): string[] {
  if (output === null || output.trim() === '') return [];
  const summary = summarize(command, { stdout: output, exitCode: null }, 0);
  return [...new Set(summary.failing.filter((id) => id !== RUN_FAILURE_ID))].sort();
}

// ---------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------

/** What one round cost and what it saw, independent of the synthesizer's own accounting (§4.4 bound 3). */
export interface FastPathTelemetry {
  /** the facade's own clock diff */
  wallMs: number;
  /** Jev latency spent inside the round, summed off the wrapped `ctx.ask` */
  jevMs: number;
  jevRequests: number;
  testRuns: number;
  sites: number;
  poolSize: number;
  runMode: 'SIEVE' | 'RANK';
  candidatesTested: number;
  passer: boolean;
  confirmedCold: boolean;
  structuralDrops: number;
  /** a lone passer was being held at the round's last guard decision (`GuardFields.held`), a presence not a count */
  heldAny: boolean;
  dropped: number;
}

export type FastPathRoundResult =
  | { kind: 'proposed'; proposal: Proposal; telemetry: FastPathTelemetry }
  | { kind: 'declined'; reason: FastPathReason; telemetry: FastPathTelemetry }
  | { kind: 'failed'; reason: FastPathReason; outcome: 'no_passer' | 'refused' | 'timeout' | 'error'; telemetry: FastPathTelemetry };

/** Per-run state the engine-side predicate reads for T10 / T11 (§4.5 one-strike disarm). */
export interface FastPathRunState {
  disarmed: boolean;
  /** T10: fingerprints already declined or exhausted this run */
  seen: Set<string>;
  /** T11: rounds entered per fingerprint */
  attempts: Map<string, number>;
  /**
   * §4.4: wall every round of this run has spent BETWEEN THEM, against `fastPathRunWallCapMs`. T9 bounds one round;
   * without this the sum over a long run is unbounded, because a new round arms whenever wall remains.
   */
  wallSpentMs: number;
}

export interface FastPathRunnerOptions {
  /** injectable clock (tests) */
  now?: () => number;
  /** test seam: the search deps the round's synthesizer is built from; default is the real `searchDeps()` */
  deps?: () => SearchDeps;
  /**
   * test seam: build the synthesizer from the (wrapped) deps and the clamp. The default is exactly the body of
   * `createSynthesizer({ mode: 'jev-only' })` (`src/synth/index.ts`) plus the clamp — the fast path owns its
   * synthesizer because `src/cli/session.ts` builds one only for `jev-only | llm-jev`, so a fast path that needed the
   * ENGINE's synthesizer would be permanently unreachable in `jev-on` (§4.2).
   */
  create?: (deps: SearchDeps, clamp: FastPathClamp) => { synthesize(ctx: SynthesisContext): Promise<Proposal> };
}

/** The guard bookkeeping a `SubGoalResult` carries at runtime beside its typed `Decision` fields (guard.ts `GuardFields`). */
interface GuardCounts {
  /** `GuardFields.held` is `HoldKind | null` — a presence, never a count; the record's member says so too */
  heldAny: boolean;
  dropped: number;
  structuralDrops: number;
}

function guardCountsOf(value: unknown): GuardCounts {
  const o = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const num = (k: string): number => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return { heldAny: o['held'] !== null && o['held'] !== undefined, dropped: num('dropped'), structuralDrops: num('structuralDrops') };
}

const EMPTY_TELEMETRY: FastPathTelemetry = {
  wallMs: 0,
  jevMs: 0,
  jevRequests: 0,
  testRuns: 0,
  sites: 0,
  poolSize: 0,
  runMode: 'SIEVE',
  candidatesTested: 0,
  passer: false,
  confirmedCold: false,
  structuralDrops: 0,
  heldAny: false,
  dropped: 0,
};

/**
 * One fast path per engine. It owns a synthesizer per `runId` (§4.6: `scratch.startedMs` is per instance and never reset
 * across runs, so a reused instance mis-sizes every budget), the run's disarm/fingerprint state, and the clamp object
 * whose fields each round rewrites before `synthesize()` is called.
 */
export class FastPathRunner {
  private readonly now: () => number;
  private readonly makeDeps: () => SearchDeps;
  private readonly create: (deps: SearchDeps, clamp: FastPathClamp) => { synthesize(ctx: SynthesisContext): Promise<Proposal> };
  private readonly synths = new Map<string, { synth: { synthesize(ctx: SynthesisContext): Promise<Proposal> }; clamp: FastPathClamp }>();
  private readonly states = new Map<string, FastPathRunState>();
  /** the trace of the last sub-goal search of the round in flight, captured through the wrapped deps */
  private lastTrace: GoalSearchTrace | null = null;
  /** read through a method so the compiler does not narrow the field to `null` across the round's awaits */
  private trace(): GoalSearchTrace | null {
    return this.lastTrace;
  }

  private lastGuard: GuardCounts = { heldAny: false, dropped: 0, structuralDrops: 0 };
  /** the stage-2 verdict this round reached, and the abort it raised */
  private stage2: FastPathReason | null = null;
  /** §4.3 stage 2: the round's oracle-class verdict has been reached (the clamp's `observe`), once per ROUND */
  private judgedOracle = false;
  /** §4.3 stage 2: the round's site-count verdict has been reached (the wrapped localiser), once per ROUND */
  private judgedSites = false;
  /**
   * the baseline the round STARTED with. `RunMemory` outlives the round (one synthesizer per `runId`), so
   * `mem.baseline !== null` does not mean "this round measured one": on round 2 it is round 1's. Identity against
   * this is what tells the two apart — `rebaseline` assigns a fresh object.
   */
  private entryBaseline: unknown = null;
  /** the last measured (oracle, budget) the clamp saw, for the end-of-round check when no verdict was reached */
  private lastMeasured: { oracle: OracleModel; budget: StepBudget } | null = null;
  /** read through a method so the compiler does not narrow the field to `null` across the round's awaits */
  private measured(): { oracle: OracleModel; budget: StepBudget } | null {
    return this.lastMeasured;
  }
  private aborter: AbortController | null = null;

  /**
   * §4.3 stage 2, in one place: the verdict, and the abort it raises. `sites` is what the caller knows — the wrapped
   * localiser knows the real count, the clamp's pre-candidate call does not and passes 1 (the clause is then vacuous
   * and only the oracle class and the run plan are judged).
   */
  private judgeStage2(oracle: OracleModel, budget: StepBudget, sites: number): void {
    if (this.stage2 !== null) return;
    const v = fastPathStage2({ oracle, budget, sites, poolSize: 0 });
    if (v.ok) return;
    this.stage2 = v.reason;
    this.aborter?.abort();
  }

  constructor(opts: FastPathRunnerOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now());
    // §4.2: the fast path's own `jev-only` wiring — `createSynthesizer({ mode: 'jev-only' })`'s exact body
    // (`src/synth/index.ts`: `new LedgerSieveSynthesizer(searchDeps())`), plus the one-round clamp.
    this.makeDeps = opts.deps ?? ((): SearchDeps => searchDeps());
    this.create = opts.create ?? ((d, clamp): { synthesize(ctx: SynthesisContext): Promise<Proposal> } => new LedgerSieveSynthesizer(d, { fastPath: clamp }));
  }

  state(runId: string): FastPathRunState {
    let s = this.states.get(runId);
    if (s === undefined) {
      s = { disarmed: false, seen: new Set<string>(), attempts: new Map<string, number>(), wallSpentMs: 0 };
      this.states.set(runId, s);
    }
    return s;
  }

  /**
   * §4.6: the engine's 4-entry window is fed to the round's memory on EVERY step of an armed run, not only on rounds.
   * The synthesizer records a commit when it PROPOSES; `patchNotExecutedLastStep` + `rollbackUnexecutedPatch` reconcile
   * a proposal the engine blocked, a human declined, or an apply failed — and the window keeps only 4 entries, so a
   * fast path that observed only on its own intermittent rounds would leave the ledger claiming a commit the workspace
   * never took.
   */
  observe(runId: string, window: readonly WindowEntry[]): void {
    if (!this.synths.has(runId)) return;
    observeWindow(runMemory(runId), window);
  }

  /** §4.5 one-strike disarm: the fast path is out for the rest of this run. */
  disarm(runId: string): void {
    this.state(runId).disarmed = true;
  }

  /** §4.6: the per-run synthesizer and its search memory (`MEMORIES_MAX = 4`, ~0.4 GB on a repository corpus) go at run end. */
  dispose(runId: string): void {
    if (this.synths.delete(runId)) dropMemory(runId);
    this.states.delete(runId);
  }

  /**
   * One bounded round. Returns a cold-confirmed patch proposal, or a typed refusal — never a throw, except the run's
   * own abort (a pause point, an interrupt), which is re-raised so the step is interrupted exactly like every other propose
   * (§6 row 7). The partial round is discarded, never cached as a replayable proposal.
   */
  async run(ctx: SynthesisContext, budget: FastPathBudget): Promise<FastPathRoundResult> {
    const state = this.state(ctx.runId);
    const started = this.now();
    this.lastTrace = null;
    this.lastGuard = { heldAny: false, dropped: 0, structuralDrops: 0 };
    this.stage2 = null;
    // §4.3 stage 2 is a per-ROUND verdict: every flag it keys off is reset here, and the round's entry baseline is
    // recorded so a measurement an EARLIER round made is never mistaken for this round's.
    this.judgedOracle = false;
    this.judgedSites = false;
    this.lastMeasured = null;
    this.entryBaseline = runMemory(ctx.runId).baseline;

    const own = new AbortController();
    this.aborter = own;
    const ceiling = AbortSignal.timeout(fastPathCeilingMs(budget));
    const signal = AbortSignal.any([ctx.signal, own.signal, ceiling]);

    let jevMs = 0;
    let jevRequests = 0;
    const askFn = ctx.ask;
    const ask: SynthesisContext['ask'] = async (stage, state2, questions) => {
      jevRequests += 1;
      const r = await askFn(stage, state2, questions);
      jevMs += Math.max(0, r.latencyMs);
      return r;
    };
    const inner: SynthesisContext = { ...ctx, signal, ask };

    const { synth, clamp } = this.synthFor(ctx.runId);
    clamp.testRuns = Math.max(0, Math.floor(budget.testRuns));
    clamp.wallMs = Math.max(0, Math.floor(budget.wallMs));
    clamp.reserveMs = Math.max(0, Math.floor(budget.reserveMs));
    clamp.jevRequests = Math.max(0, Math.floor(budget.jevRequests));

    ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:entered', detail: `one sieve round: ${clamp.wallMs} ms wall (+${Math.round(budget.reserveMs)} ms confirm reserve), ${clamp.testRuns} runs, ${clamp.jevRequests} Jev requests, 0 generator samples` });

    const telemetry = (over: Partial<FastPathTelemetry> = {}): FastPathTelemetry => {
      const t = this.trace();
      return {
        ...EMPTY_TELEMETRY,
        wallMs: Math.max(0, this.now() - started),
        jevMs,
        jevRequests: t === null ? jevRequests : Math.max(jevRequests, t.jevRequests),
        testRuns: t?.testRuns ?? 0,
        sites: t?.sitesConsidered ?? 0,
        poolSize: t?.candidatesEnumerated ?? 0,
        runMode: t?.runMode ?? 'SIEVE',
        candidatesTested: t?.candidatesTested ?? 0,
        heldAny: this.lastGuard.heldAny,
        dropped: this.lastGuard.dropped,
        structuralDrops: this.lastGuard.structuralDrops,
        ...over,
      };
    };

    try {
      const proposal = await synth.synthesize(inner);
      // §4.3 stage 2: a round that reached NO verdict (a localiser cache hit on an unchanged workspace, so neither the
      // clamp's fresh-baseline call nor the localiser ran) is judged here on the measurement it did have, rather than
      // proposing out of a round whose eligibility was never established.
      if (!this.judgedOracle && !this.judgedSites) {
        const m = this.measured();
        if (m === null) {
          // §4.7's `emptyStepBudget` row: the round returned without ever measuring a baseline, so stage 2 was never
          // decidable. Unreachable on the normal path (`step()` re-baselines whenever `mem.baseline` is null) and
          // therefore reported as the broken-round shape it is, never as a proposal.
          state.disarmed = true;
          ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:abandoned', detail: 'stage 2: no baseline was measured' });
          return { kind: 'failed', reason: 'empty_step_budget', outcome: 'error', telemetry: telemetry() };
        }
        this.judgeStage2(m.oracle, m.budget, this.trace()?.sitesConsidered ?? 1);
      }
      // the verdict is raised from inside the round (the clamp's `observe`, the wrapped localiser) and
      // aborts it. A search that does not poll its signal can still reach here with a proposal; the decline stands —
      // the round was refused before a candidate was priced, and a refused round proposes nothing.
      const late = this.stage2;
      if (late !== null) {
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:declined', detail: `stage 2: ${late}` });
        return { kind: 'declined', reason: late, telemetry: telemetry() };
      }
      const accepted = acceptFastPathProposal(proposal);
      if (!accepted.accept) {
        // §4.5: a refusal disarms; a plain "no passer" does not — nothing went wrong, the cluster simply had no fix here
        if (accepted.outcome === 'refused') state.disarmed = true;
        const at = this.trace();
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:abandoned', detail: `${accepted.reason} (${accepted.outcome})`, ...(at === null ? {} : { tested: at.candidatesTested }) });
        return { kind: 'failed', reason: accepted.reason, outcome: accepted.outcome, telemetry: telemetry({ confirmedCold: accepted.confirmedCold, passer: accepted.outcome === 'refused' }) };
      }
      // §4.3 stage 2, recorded after the fact for the clauses the controller alone can see: a round that was RANK, or
      // one whose localiser returned nothing (the Ring 1 defect, code-fixed at 0d61eef), disarms rather than repeating.
      const t = this.trace();
      if (t !== null && t.sitesConsidered === 0) {
        state.disarmed = true;
        return { kind: 'declined', reason: 'no_sites', telemetry: telemetry() };
      }
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:confirmed', detail: `cold-confirmed patch: ${proposal.evidence?.newlyPassing.length ?? 0} newly passing, 0 newly failing`, ...(t === null ? {} : { tested: t.candidatesTested }) });
      return { kind: 'proposed', proposal, telemetry: telemetry({ passer: true, confirmedCold: true }) };
    } catch (err) {
      if (ctx.signal.aborted) throw err instanceof Error ? err : new AbortError('error');
      const stage2 = this.stage2;
      if (stage2 !== null) {
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:declined', detail: `stage 2: ${stage2}` });
        return { kind: 'declined', reason: stage2, telemetry: telemetry() };
      }
      state.disarmed = true;
      if (ceiling.aborted) {
        ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:abandoned', detail: 'round timeout' });
        return { kind: 'failed', reason: 'confirm_timeout', outcome: 'timeout', telemetry: telemetry() };
      }
      const message = err instanceof Error ? ctx.redact(err.message) : 'unknown error';
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'fastpath:abandoned', detail: `error: ${message}` });
      return { kind: 'failed', reason: 'error', outcome: 'error', telemetry: telemetry() };
    } finally {
      this.aborter = null;
      // §4.4: the run-wide ledger is debited on EVERY exit — a decline, a failure and a re-raised abort all spent wall
      state.wallSpentMs += Math.max(0, this.now() - started);
    }
  }

  private synthFor(runId: string): { synth: { synthesize(ctx: SynthesisContext): Promise<Proposal> }; clamp: FastPathClamp } {
    const existing = this.synths.get(runId);
    if (existing !== undefined) return existing;
    const clamp: FastPathClamp = {
      testRuns: FASTPATH_TEST_RUNS_MAX,
      wallMs: 0,
      reserveMs: 0,
      jevRequests: FASTPATH_JEV_MAX,
      // §4.3 stage 2: this fires straight after `fitOracle`, before any candidate runs — the cheapest place the
      // oracle class and the run budget can be judged, and the only one that costs a single baseline run.
      observe: (mem, budget): void => {
        // before ANY baseline the oracle is `UNMEASURED_ORACLE` and judging it would refuse every round
        if (this.stage2 !== null || mem.baseline === null) return;
        this.lastMeasured = { oracle: mem.oracle, budget };
        // and a baseline THIS round did not measure is the previous round's: `freshBudget` runs at the top of
        // `synthesize()`, before the re-baseline a changed workspace is about to force, so judging there would abort
        // round 2 on round 1's oracle. That case is judged at the localiser instead, or at the end of the round.
        if (mem.baseline === this.entryBaseline || this.judgedOracle) return;
        this.judgedOracle = true;
        this.judgeStage2(mem.oracle, budget, 1);
      },
    };
    const entry = { synth: this.create(this.wrap(this.makeDeps()), clamp), clamp };
    this.synths.set(runId, entry);
    return entry;
  }

  /**
   * The deps of the round's own synthesizer, wrapped so the facade sees what the round did: the sub-goal search's trace
   * (sites considered, pool enumerated, run mode, candidates tested, test runs, Jev requests) and the guard's
   * bookkeeping. Read-only — nothing here changes what the search does.
   */
  private wrap(deps: SearchDeps): SearchDeps {
    const capture = <T>(r: T): T => {
      const o = r as unknown as { trace?: GoalSearchTrace };
      if (o.trace !== undefined) this.lastTrace = o.trace;
      this.lastGuard = guardCountsOf(r);
      return r;
    };
    return {
      ...deps,
      searchSubGoal: async (c: SynthesisContext, mem: RunMemory, goal: Goal) => capture(await deps.searchSubGoal(c, mem, goal)),
      searchBestGuess: async (c: SynthesisContext, mem: RunMemory, goal: Goal) => capture(await deps.searchBestGuess(c, mem, goal)),
      // §4.3 stage 2's deterministic point: the localiser runs after the round's baseline and BEFORE any candidate is
      // enumerated or priced, and it is the only place the real site count exists. The clamp's `observe` is the
      // earlier, cheaper half (the oracle class, one baseline run in); this is the whole predicate.
      locate: async (c: SynthesisContext, mem: RunMemory, goal: Goal): Promise<LocalizeResult> => {
        const r = await deps.locate(c, mem, goal);
        if (!this.judgedSites && mem.baseline !== null) {
          this.judgedSites = true;
          this.lastMeasured = { oracle: mem.oracle, budget: mem.stepBudget };
          this.judgeStage2(mem.oracle, mem.stepBudget, r.sites.length);
        }
        return r;
      },
    };
  }
}
