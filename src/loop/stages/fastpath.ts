/**
 * The synth fast path — route R9 of docs/LLM-LOOP-DESIGN.md §4 — as seen from the loop side.
 *
 * Everything in this file is PURE. It is the engine-side half of the route: the stage-1 trigger predicate (T1–T12,
 * pure code — zero Jev, zero LLM, zero test runs), the one-round budget arithmetic (§4.4), and the record builder for
 * `StepRecord.fastPath`. The round itself, its synthesizer and stage 2 live in `src/synth/search/fastpath.ts`; the
 * engine's own call site is a handful of lines in the `jev-on` propose branch.
 *
 * The predicate prices its own false positive, which is why it is split. Stage 1 is free; stage 2 costs one baseline
 * run plus the localiser's routed asks, and T10 makes that cost payable at most once per fingerprint per run.
 */
import type { EngineMode, FastPathReason, LastTestRun, StepFastPath } from '../../core/types.js';
import type { FastPathBudget, FastPathRoundResult, FastPathRunState } from '../../synth/search/fastpath.js';
import { FASTPATH_GRACE_MS, FASTPATH_JEV_MAX, FASTPATH_TEST_RUNS_MAX, fastPathCeilingMs, fastPathFingerprint } from '../../synth/search/fastpath.js';

export { fastPathFingerprint };

// ---------------------------------------------------------------------------------------
// Constants (§4.3, §4.4)
// ---------------------------------------------------------------------------------------

/**
 * T5: the measured `t_run` above which one round can no longer test enough of a pool to beat the LLM's guess. The
 * measured QuixBugs regime is a 9–11-site pool at t_run ≤ 520 ms fully testable in one round; 800 ms is that regime
 * with headroom, and it is the same order as `budget.ts`'s own QuixBugs-class line, which stage 2 re-applies exactly.
 */
export const FASTPATH_MAX_T_RUN_MS = 800;
/** T7: more failing tests than this is a broken build, not one cluster. */
export const FASTPATH_MAX_FAILING = 8;
/** T11: rounds one cluster may cost before the fast path stops trying it. */
export const FASTPATH_ATTEMPTS_MAX = 2;
/** §4.4: the hard ceiling on one round's wall share. */
export const FASTPATH_WALL_MAX_MS = 45_000;
/** §4.4: the share of the step's remaining wall a round may take. */
export const FASTPATH_WALL_SHARE = 0.35;
/** §4.4: below `this × t_run` the round cannot test enough to matter — DECLINE rather than enter. */
export const FASTPATH_WALL_MIN_T_RUN_MULTIPLE = 8;
/** §4.4: the cold-confirm reserve, held OUTSIDE the wall share — a passer without its confirm run is not a result. */
export const FASTPATH_CONFIRM_RESERVE_MULTIPLE = 2;
/**
 * §4.4: the share of the RUN's whole wall every fast-path round of the run may spend BETWEEN THEM.
 *
 * T9 bounds one round; nothing bounded the sum, and rounds keep arming while wall remains, so a long run could spend
 * an unbounded fraction of itself in the fast path and still hand every step back to the LLM. The ledger is kept on
 * `FastPathRunState.wallSpentMs` and enters the budget as `runWallLeftMs`.
 */
export const FASTPATH_RUN_WALL_SHARE = 0.25;

/** §4.4: the run-wide fast-path wall ledger's cap, from the run's own wall limit. */
export function fastPathRunWallCapMs(maxWallMs: number): number {
  return Math.max(0, Math.floor(Math.max(0, maxWallMs) * FASTPATH_RUN_WALL_SHARE));
}

// ---------------------------------------------------------------------------------------
// §4.4 — the budget
// ---------------------------------------------------------------------------------------

export interface FastPathBudgetInput {
  /** the engine's last parsed test run's wall (T5) */
  tRunMs: number;
  /** the full-suite run's wall, when known; the goal-subset run stands in when it is not */
  fullSuiteMs?: number;
  /**
   * wall the RUN has left, which is what the share is taken of.
   *
   * The design's table says "the step's remaining wall"; `Limits` has no per-step wall (`checkBudgets` bounds the RUN,
   * `engine.ts wallRemainingMs`), so there is no such number to pass and the field is named for what it really is. The
   * aggregate is bounded by `runWallLeftMs` below rather than by a step limit that does not exist.
   */
  wallRemainingMs: number;
  /**
   * §4.4: what the run-wide fast-path wall ledger has left (`fastPathRunWallCapMs` minus the wall earlier rounds
   * spent). Omitted = unbounded, which is what the pure unit tests of the share arithmetic want.
   */
  runWallLeftMs?: number;
  /**
   * runs the oracle can afford, when the caller knows it. The engine has no oracle at stage 1, so it passes nothing
   * and the oracle-derived bound enters where it is actually known: the clamp mins this cap with the synthesizer's own
   * `testRunsLeft`, which `freshBudget` computed from the fitted oracle (`src/synth/search/index.ts`).
   */
  runsAffordable?: number;
}

/**
 * §4.4: the one-round share, or `null` when the round cannot be worth entering.
 *
 * `null` is the floor clause, and it is a decline, not a clamp: a share below `8 × t_run` buys at most seven candidates
 * and the LLM's own guess is cheaper than that. Returning a tiny budget instead would spend the wall and then hand the
 * step back to the LLM anyway, which is the wasted-wall regression the whole route is bounded against (T9, T11).
 */
export function fastPathBudget(i: FastPathBudgetInput): FastPathBudget | null {
  const tRun = Math.max(1, Math.floor(i.tRunMs));
  const ledger = i.runWallLeftMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(i.runWallLeftMs));
  const share = Math.min(FASTPATH_WALL_MAX_MS, ledger, Math.floor(Math.max(0, i.wallRemainingMs) * FASTPATH_WALL_SHARE));
  const floor = FASTPATH_WALL_MIN_T_RUN_MULTIPLE * tRun;
  if (share < floor) return null;
  const wallMs = Math.min(share, FASTPATH_WALL_MAX_MS);
  const full = Math.max(tRun, Math.floor(i.fullSuiteMs ?? tRun));
  return {
    wallMs,
    testRuns: Math.max(1, Math.min(FASTPATH_TEST_RUNS_MAX, Math.floor(i.runsAffordable ?? FASTPATH_TEST_RUNS_MAX))),
    jevRequests: FASTPATH_JEV_MAX,
    reserveMs: FASTPATH_CONFIRM_RESERVE_MULTIPLE * full,
    graceMs: FASTPATH_GRACE_MS,
  };
}

// ---------------------------------------------------------------------------------------
// §4.3 stage 1 — the engine-side predicate
// ---------------------------------------------------------------------------------------

/**
 * The T1–T5, T7, T9 and T12 clauses: everything decidable from engine state ALONE, with no workspace listing. This is
 * the pass that runs on every armed step, and on a `jev-on` run whose last step was not a parsed failing test run —
 * which is most steps of most runs — it leaves after three field reads. Arming therefore costs nothing where it
 * cannot fire, which is what makes `fastPath: 'auto'` safe as the `jev-on` default.
 */
export interface FastPathFreeInput {
  /** T1 */
  mode: EngineMode;
  /** T1: the resolved option ('auto' in jev-on, 'off' elsewhere; `JEVCODE_FASTPATH` overrides) */
  option: 'auto' | 'off';
  /** T3/T5: the engine's last parsed test run, `durationMs` included after contract 1.9 */
  lastTestRun: LastTestRun | null;
  /** T3: that run executed the workspace's detected test command (`isTestCommand`) */
  lastRunWasTestCommand: boolean;
  /** T3: `scopeUsable()` over its parsed counts */
  scopeUsable: boolean;
  /** T4: the step of the last executed workspace change, or null */
  lastChangeStep: number | null;
  /** T9: dollars the run may still spend */
  spendLeftUsd: number;
  /** T11 / §4.5: one-strike disarm */
  disarmed: boolean;
  /** T12 */
  loopTripped: boolean;
  /** T12 */
  pausePending: boolean;
  /**
   * §4.5 / I8: the warm plane is switched on for this process (`warmPlaneEnabled`, `JEVCODE_WARM`).
   *
   * The whole acceptance rule reduces "cold-confirmed" to "the regression run exists and passed" only while every
   * lane run is cold; with the plane on, a warm-screened passer produces the same `shadow_test_run` evidence and
   * would be recorded `confirmedCold: true` on no evidence of coldness at all. The fast path owns its synthesizer but
   * not the plane's switch, so it refuses to enter rather than make a claim it cannot check — a named decline before
   * any wall is spent, not a false record after it.
   */
  warmEnabled: boolean;
}

/** The clauses that need the workspace listing (T2, T6, T8) or the cluster's identity (T9–T11), evaluated second. */
export interface FastPathWorkspaceInput {
  /** T2: `synthesizerHandles(wsInfo, files)`, cached once per run */
  handles: boolean;
  /** T6: the code-derived suspect set (`fastPathSuspects`) */
  suspects: readonly string[];
  /** T8: `isRepositoryWorkspace(testCommand, paths)` */
  repository: boolean;
  /** T8: `detectLayout(paths) !== 'other'` */
  layoutDetected: boolean;
  /** T12: a coordination lease conflict is already known on the implicated file */
  leaseConflict: boolean;
  /** T9: wall the RUN has left */
  wallLeftMs: number;
  /** T9/T11: the round's share, or null when the floor clause declined */
  budget: FastPathBudget | null;
  /** T10/T11: the cluster's `(file, failing-test-id-set)` fingerprint (`fastPathFingerprint`) */
  fingerprint: string;
  /** T10/T11: the run's fast-path state */
  state: Pick<FastPathRunState, 'seen' | 'attempts'>;
}

export type FastPathStage1Input = FastPathFreeInput & FastPathWorkspaceInput;

export type FastPathGate = { fire: true; file: string } | { fire: false; reason: FastPathReason };

/** T1–T5, T7, T9 (spend), T12 — free. `null` means "keep going"; anything else is the decline. */
export function fastPathStage1Free(i: FastPathFreeInput): FastPathReason | null {
  // T1
  if (i.option !== 'auto') return 'off';
  if (i.mode !== 'jev-on') return 'not_jev_on';
  // §4.5 / I8: free, and before anything else that could spend — see `warmEnabled` above
  if (i.warmEnabled) return 'warm_plane';
  // T11 — disarm before anything else, so a disarmed run costs one comparison per step
  if (i.disarmed) return 'disarmed';
  // T3: a parsed test run of the workspace's own test command, with something failing
  const run = i.lastTestRun;
  if (run === null || !i.lastRunWasTestCommand) return 'no_parsed_run';
  if (!i.scopeUsable) return 'scope_unusable';
  if (run.allPassed || run.failed + run.errors < 1) return 'all_passing';
  // T7: more than this is a broken build, not one cluster
  if (run.failed + run.errors > FASTPATH_MAX_FAILING) return 'too_many_failures';
  // T4: no workspace write since that run
  if (i.lastChangeStep !== null && i.lastChangeStep >= run.step) return 'workspace_changed';
  // T5: `durationMs` is the contract-1.9 member that makes this survive a resume; unknown means "cannot arm yet"
  if (run.durationMs === undefined) return 'no_parsed_run';
  if (run.durationMs > FASTPATH_MAX_T_RUN_MS) return 't_run_too_slow';
  // T12
  if (i.loopTripped) return 'loop_tripped';
  if (i.pausePending) return 'pause_pending';
  // T9, the half that needs no budget
  if (i.spendLeftUsd <= 0) return 'no_wall';
  return null;
}

/** T6, T8, T2, T10, T11, T9 (wall) — the clauses that cost a workspace listing or know the cluster. */
export function fastPathStage1Workspace(i: FastPathWorkspaceInput): FastPathGate {
  // T6: exactly one non-test source file
  if (i.suspects.length !== 1) return { fire: false, reason: 'multi_file' };
  const file = i.suspects[0] ?? '';
  // T8: a repository is refused here, again by oracle class at stage 2, and a third time by the run plan (§6 row 5)
  if (i.repository || !i.layoutDetected) return { fire: false, reason: 'repository_class' };
  // T12, now that the implicated file is known
  if (i.leaseConflict) return { fire: false, reason: 'lease_conflict' };
  // T2: the only clause that costs a workspace listing
  if (!i.handles) return { fire: false, reason: 'no_synthesizer' };
  // T10 / T11
  if (i.state.seen.has(i.fingerprint)) return { fire: false, reason: 'fingerprint_seen' };
  if ((i.state.attempts.get(i.fingerprint) ?? 0) >= FASTPATH_ATTEMPTS_MAX) return { fire: false, reason: 'attempts_exhausted' };
  // T9: never enter a round that cannot finish — the wall left must cover the share AND its confirm reserve twice
  const b = i.budget;
  if (b === null) return { fire: false, reason: 'no_wall' };
  if (i.wallLeftMs < 2 * (b.wallMs + b.reserveMs)) return { fire: false, reason: 'no_wall' };
  return { fire: true, file };
}

/**
 * T1–T12, composed. The two halves are separately exported because the engine pays for the workspace listing only
 * once the free half holds; this is the whole predicate as one structural function, and what the unit tests drive.
 */
export function fastPathStage1(i: FastPathStage1Input): FastPathGate {
  const free = fastPathStage1Free(i);
  if (free !== null) return { fire: false, reason: free };
  return fastPathStage1Workspace(i);
}

// ---------------------------------------------------------------------------------------
// §5.2 — the record
// ---------------------------------------------------------------------------------------

/** A stage-1 decline: one row, no cost, and the reason the §8 histogram counts. */
export function declinedRecord(reason: FastPathReason, tRunMs: number, disarmed: boolean): StepFastPath {
  return {
    decision: 'declined',
    reason,
    stage: 1,
    outcome: 'skipped',
    tRunMs,
    sites: 0,
    poolSize: 0,
    runMode: 'SIEVE',
    candidatesTested: 0,
    testRuns: 0,
    jevRequests: 0,
    wallMs: 0,
    budgetMs: 0,
    shareMs: 0,
    passer: false,
    confirmedCold: false,
    structuralDrops: 0,
    heldAny: false,
    dropped: 0,
    disarmed,
  };
}

/**
 * The record of a round that ran: what it decided, what it saw and what it cost (§4.7's table, one row per outcome).
 *
 * `budgetMs` is the round's CEILING (`fastPathCeilingMs`: share + confirm reserve + grace), not the wall share, because
 * §8 row R-b reads `wallMs <= budgetMs` as a gate on every fired step and the share does not bound the round: only the
 * sieve's `testWallLeftMs` is clamped to it, while the round's baseline run, the localiser and the confirm run are all
 * outside that counter. The ceiling IS the bound (the abort ceiling enforces it), so the gate is now a fact rather than
 * a claim. The installed share is recorded beside it as `shareMs`.
 */
export function firedRecord(result: FastPathRoundResult, o: { tRunMs: number; budget: FastPathBudget; disarmed: boolean }): StepFastPath {
  const t = result.telemetry;
  const base = {
    reason: result.kind === 'proposed' ? ('none' as FastPathReason) : result.reason,
    tRunMs: o.tRunMs,
    sites: t.sites,
    poolSize: t.poolSize,
    runMode: t.runMode,
    candidatesTested: t.candidatesTested,
    testRuns: t.testRuns,
    jevRequests: t.jevRequests,
    wallMs: t.wallMs,
    budgetMs: fastPathCeilingMs(o.budget),
    shareMs: o.budget.wallMs,
    passer: t.passer,
    confirmedCold: t.confirmedCold,
    structuralDrops: t.structuralDrops,
    heldAny: t.heldAny,
    dropped: t.dropped,
    disarmed: o.disarmed,
  };
  if (result.kind === 'proposed') return { ...base, decision: 'fired', stage: 2, outcome: 'proposed' };
  // §4.7: a stage-2 decline spent one baseline run and the localiser's asks; a failure spent the round
  if (result.kind === 'declined') return { ...base, decision: 'declined', stage: 2, outcome: 'skipped' };
  return { ...base, decision: 'failed', stage: 2, outcome: result.outcome };
}
