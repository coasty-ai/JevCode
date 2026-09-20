/**
 * Shared types of the Ledger + Sieve search (docs/JEV-ONLY-DESIGN.md §6.1). Frozen for the
 * parallel build; modules under src/synth/search, src/synth/sieve, src/synth/sketch and
 * src/synth/fill implement against these.
 */
import type { Json } from '../../core/types.js';
import type { AppliedCandidate, Candidate, CandidateSourceName, FailureView, LineEdit, Progress, SearchTrace, Site, SourceFile, TestRunSummary } from '../types.js';

export type GoalStatus = 'open' | 'active' | 'parked' | 'fixed';
export type Phase = 'SEEDS' | 'SKETCH' | 'BEAM' | 'WIDENED';
export const PHASES: readonly Phase[] = ['SEEDS', 'SKETCH', 'BEAM', 'WIDENED'];

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
  /** consecutive budget-hit steps (2 → park) */
  budgetHits: number;
  /** siteKey → sources fully enumerated + run at that site */
  exhausted: Map<string, Set<CandidateSourceName>>;
  phase: Phase;
  parkedReason?: string;
  /** `fix <first_test_id>[, +N more] in <path>` */
  planItem: string;
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
  startedMs: number;
  recursed: boolean;
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

export type VerifyStatus = 'plausible' | 'partial' | 'regressed' | 'unchanged' | 'timeout' | 'apply_failed';

export interface VerifyOutcome {
  job: VerifyJob;
  applied: AppliedCandidate;
  /** goal-subset run */
  subset: TestRunSummary;
  /** full-suite regression run, only for subset passers */
  full?: TestRunSummary;
  progress: Progress;
  status: VerifyStatus;
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
  /** pEscape ≥ 0.9 && max(noul) < 0.1 */
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
