/**
 * Shared types of the Ledger + Sieve search (docs/JEV-ONLY-DESIGN.md §6.1). Frozen for the
 * parallel build; modules under src/synth/search, src/synth/sieve, src/synth/sketch and
 * src/synth/fill implement against these.
 */
import type { Json } from '../../core/types.js';
import type { AppliedCandidate, Candidate, CandidateSourceName, FailureView, LineEdit, Progress, SearchTrace, Site, SourceFile, TestRunSummary } from '../types.js';

export type GoalStatus = 'open' | 'active' | 'parked' | 'fixed';
/** The phase ladder; 'LLM' (docs/LLM-JEV-DESIGN.md §4.2) runs only when an LLM source is wired, SKETCH/BEAM only once its rounds are spent. */
export type Phase = 'SEEDS' | 'LLM' | 'SKETCH' | 'BEAM' | 'WIDENED';
export const PHASES: readonly Phase[] = ['SEEDS', 'LLM', 'SKETCH', 'BEAM', 'WIDENED'];

export interface Goal {
  /** "g3" */
  id: string;
  /** failing test ids in this cluster */
  tests: string[];
  /** expected / actual per test (code-computed, bounded) */
  failures: FailureView[];
  /** traceback frames + SBFL, refined by localisation */
  suspectedFiles: string[];
  /**
   * Names the failure text says are missing (`NameError: name 'X' is not defined`,
   * `ImportError: cannot import name 'X'`, `ModuleNotFoundError: No module named 'X'`), first
   * seen first; absent when no failing test raised one. Traceback-derived, code-computed
   * (goals.ts `missingNamesIn`); sites.ts turns it into the module-level import gap of every
   * suspected file that uses the name unbound.
   */
  missingNames?: string[];
  status: GoalStatus;
  /** searches run for this goal */
  attempts: number;
  /** consecutive budget-hit steps that tested nothing new (§5.3: 2 → park); a step that tested fresh candidates at a new site does not count */
  budgetHits: number;
  /** every consecutive budget-hit step, progress or not (§5.3 hard cap: 4 → park); in-memory only, a resumed run starts at 0 */
  budgetSteps?: number;
  /** siteKey → sources fully enumerated + run at that site */
  exhausted: Map<string, Set<CandidateSourceName>>;
  /** siteKeys where ≥ 1 candidate of this goal was classified by a run, across steps (§5.3 progress); reset with `exhausted` */
  testedSites?: Set<string>;
  phase: Phase;
  parkedReason?: string;
  /** `fix <first_test_id>[, +N more] in <path>` */
  planItem: string;
  /**
   * Partial fixes committed for this goal so far (goals.ts noteCommit): after
   * MAX_PROGRESS_COMMITS_PER_GOAL the remaining tests continue under a new goal id, so the
   * ledger shows the chain. In-memory only, like `budgetSteps`.
   */
  progressCommits?: number;
}

export interface Base {
  id: string;
  origin: 'committed' | 'improved';
  fromGoal: string | null;
  files: ReadonlyMap<string, SourceFile>;
  summary: TestRunSummary;
  /** the edit that produced an 'improved' base */
  candidate?: AppliedCandidate;
  /** ≤ 3 edits above the committed workspace */
  depth: number;
}

export interface OracleModel {
  runner: 'quixbugs' | 'pytest' | 'other';
  lanes: number;
  tRunMs: { goalSubset: number; fullSuite: number };
  /** QuixBugs runner only */
  perTestTimeoutMs: number | null;
  runTimeoutMs: number;
  baselineDurationMs: number;
}

export interface StepBudget {
  jevRequestsLeft: number;
  testRunsLeft: number;
  testWallLeftMs: number;
  /**
   * contract 1.9 (Fastlane) §4.4: wall inside `testWallLeftMs` that is RESERVED and must not be spent on dispatching
   * another candidate — the fast path's cold-confirm reserve. The sieve stops starting new lane runs while only this
   * much is left, so the passer's full-suite confirm still has wall when the candidate phase ends. Absent (every other
   * caller) = 0, which is exactly today's dispatch rule.
   */
  reserveWallMs?: number;
  startedMs: number;
  recursed: boolean;
  /**
   * docs/LLM-JEV-DESIGN.md §4.11: the LLM counters of the step — rounds (2), samples (N × 2) and the dollar cap
   * `min($0.02, (spendCap − spent) / stepsLeft)`. They never end a step (`exhausted()` ignores them); a spent counter
   * only skips the round (§4.2). Zero in jev-only, where no LLM source is wired.
   */
  llmRoundsLeft: number;
  llmSamplesLeft: number;
  llmUsdLeft: number;
  exhausted(): boolean;
}

export type RunMode = 'SIEVE' | 'RANK';
export interface RunPlan {
  mode: RunMode;
  k: number;
  runsAllowed: number;
}

export interface VerifyJob {
  candidate: Candidate;
  base: Base;
  /** Noul/Choice p in RANK mode, source prior in SIEVE mode */
  p: number;
  sourcePrior: number;
  /** (base.summary.passed, p, sourcePrior), all descending */
  key: [number, number, number];
}

/**
 * `unstable`: the candidate passed the goal's reproduction once and failed the confirmation run in
 * the same lane (oracle/verify.ts runRepositoryQueue): never a fix, never regression-tested. Until
 * the runner emits it, such an outcome is `unchanged` with its subset failure text prefixed
 * `UNSTABLE_ACTUAL_PREFIX` (`isUnstableOutcome` tells it apart).
 */
export type VerifyStatus = 'plausible' | 'partial' | 'regressed' | 'unchanged' | 'unstable' | 'timeout' | 'apply_failed';

export interface VerifyOutcome {
  job: VerifyJob;
  applied: AppliedCandidate;
  /** goal-subset run */
  subset: TestRunSummary;
  /** full-suite regression run, only for subset passers */
  full?: TestRunSummary;
  progress: Progress;
  status: VerifyStatus;
  /**
   * docs/HARNESS-NEXT-DESIGN.md §3 M6: at least one of this candidate's runs was produced by a
   * warm lane worker (a fork of a persistent interpreter) rather than a fresh process. A screen,
   * not a verdict — see `confirmedCold`.
   *
   * UNFINISHED CONTRACT, handed on by wave S1 and named here so it is not lost. §3 M6 requires
   * `screened: true` to ride into `ProposalEvidence`, and §4.4 / §5 require `screened` and
   * `screenMismatches` in `GoalSearchTrace` with `screenMismatches = 0` as a BLOCKING Ring-2
   * metric. Both readers are outside wave S1's boundary — `src/synth/search/guard.ts` builds
   * `ProposalEvidence` and `src/core/types.ts` declares `GoalSearchTrace`, and both are held by
   * other branches in flight. Until they land, the only signal is the free-text `warm …,
   * N screen:mismatch` clause the sieve appends to its `synth` verify event (`warmNote`), which
   * a human can read in the transcript but `experiments/fastlane/quick-table.mts` cannot read
   * out of `steps.jsonl`. The numbers themselves are already computed and cumulative on
   * `RunnerMemory.warm.stats()`, so wiring them is a field and an assignment, not a mechanism.
   */
  screened?: boolean;
  /**
   * The `plausible` verdict was re-established by a cold, fresh-spawn full-suite run. Set on
   * every screened passer the sieve returns: the rule is that a hot-screened passer never
   * reaches `search/guard.ts decide()` without it, and the confirmation is never skipped.
   */
  confirmedCold?: boolean;
}

export interface BehaviourCluster {
  id: string;
  members: VerifyOutcome[];
  representative: VerifyOutcome;
  signature: string;
}

export interface Arbitration {
  pick: VerifyOutcome;
  fallbacks: VerifyOutcome[];
  pChoice: Record<string, number>;
  pEscape: number;
  noul: Record<string, number>;
  /** the all-overfit signature (guard.ts rule (1)): pEscape ≥ SUSPECT_ESCAPE_MIN (0.5) && max(noul) < SUSPECT_NOUL_MAX (0.3); the set is dropped, not held — nothing is committed now, on the budget reserve or at step end */
  suspect: boolean;
  requests: number;
}

export type Decision =
  | {
      kind: 'commit';
      applied: AppliedCandidate;
      allGoalTestsPass: boolean;
      note?: 'possible overfit' | 'partial';
      /** the shadow test run the commit rests on (guard commits); search/proposal.ts turns it into `Proposal.evidence` */
      outcome?: VerifyOutcome;
      /** the held base's full-suite summary (bases.ts commitPartial, which has no outcome); `after` of the evidence */
      after?: TestRunSummary;
    }
  | { kind: 'continue' }
  | { kind: 'budget' }
  | { kind: 'parked'; reason: string };

export interface SketchHypothesis {
  site: Site;
  toks: string[];
  /** indices into toks; `_` or `<op>` */
  holes: number[];
  /** 'P1' … 'P13' */
  production: string;
  pSketch: number;
  /** Σ log p over filled slots (ordering only) */
  logP: number;
  extraEdits?: LineEdit[];
}

export type LaneMode = 'candidate_file' | 'worktree' | 'copy' | 'inplace';
export interface Lane {
  index: number;
  dir: string;
  mode: LaneMode;
  busy: boolean;
}

export interface GoalSearchTrace extends SearchTrace {
  goalId: string;
  phase: Phase;
  runMode: RunMode;
  plausible: number;
  clusters: number;
  arbitrated: boolean;
  tRunMs: number;
  /** distinct sites where ≥ 1 candidate was classified this step */
  sitesTested: number;
  /** of those, sites no earlier step of this goal had tested (§5.3: a budget-hit step with ≥ 1 is progress) */
  newSitesTested: number;
  /** candidates that passed the reproduction once and failed the confirmation run (`VerifyStatus` `unstable` / `isUnstableOutcome`); absent when none was counted */
  unstable?: number;
  /** llm-jev (docs/LLM-JEV-DESIGN.md §3, §9.2 stage 1 `StepRecord.verify`): the LLM rounds of this search; absent without an LLM source */
  llm?: LlmTrace;
}

/** Code-computed counts of the LLM rounds one sub-goal search made (search/subgoal.ts settles them from the rounds' summaries). */
export interface LlmTrace {
  rounds: number;
  samples: number;
  valid: number;
  /** distinct candidates after dedupe */
  distinct: number;
  malformed: number;
  timeouts: number;
  cancelled: number;
  misanchored: number;
  /** ms the loop waited for sample 0 after a seed passer landed (§6.2 grace) */
  graceMs: number;
  /** Q17's fix-absent signal of the last RANK round (routing only, never a gate) */
  fixAbsent: 'strong' | 'weak' | null;
  /**
   * contract 1.9 (Fastlane) §3.1: time to first byte of every sample of this search's rounds that opened a stream,
   * in the rounds' order. ABSENT when nothing measured one — the channel forwarded no `onFirstByte`, or every sample
   * timed out silent — which is a different fact from "the first byte took 0 ms".
   */
  ttfbMs?: readonly number[];
  /** contract 1.9 (Fastlane) §3.2: hedge twins this search fired; absent when hedging was off or none fired. */
  hedges?: number;
  /** contract 1.9 (Fastlane) §3.2: twins whose result arrived while their origin's had not — what the hedge bought. */
  hedgeWins?: number;
  /** contract 1.9 (Fastlane) §3.4: prompt tokens the provider served from ITS cache; absent when it reported none. */
  cacheRead?: number;
  /** contract 1.9 (Fastlane) §3.4: prompt tokens written to the provider's cache; absent when it reported none. */
  cacheWrite?: number;
  /** contract 1.9 (Fastlane) §3.4: the input tokens those two are a share of — `StepVerifySummary.cacheHitRate`'s denominator. */
  cacheInput?: number;
}

/** What survives a checkpoint (SynthesisContext.synthState); everything else is rebuilt from the plan and the workspace. */
export interface PersistedSearchState {
  version: 1;
  /** sha12(diff) of every candidate ever run */
  tried: string[];
  /** goalId → how far the WIDENED phase got */
  widenCursor: Record<string, number>;
  /** goalId → status/attempts/budgetHits/phase/parkedReason */
  goals: Record<string, { status: GoalStatus; attempts: number; budgetHits: number; phase: Phase; parkedReason?: string; tests: string[]; planItem: string }>;
  committedDiffHashes: string[];
}

export function isPersistedSearchState(v: Json | null): v is PersistedSearchState & Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { version?: unknown }).version === 1 && Array.isArray((v as { tried?: unknown }).tried);
}
