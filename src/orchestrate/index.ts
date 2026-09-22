/**
 * The one facade the surface imports (docs/ORCHESTRATION-DESIGN.md §8.1 rule 2, §8.2 D1 item 16).
 *
 * §8.1 rule 1 in the other direction: nothing under `src/orchestrate/**` imports `src/tui/**`,
 * `src/cli/**`, `src/session/**` or `src/config/**`. Every environmental fact — `home`, the clock,
 * git, the ledger handle, the commit identity, the resolved `orchestrate.*` settings — arrives as an
 * argument, which is why this module exports the seam types (`RunGit`, `Clock`, `AskFn`,
 * `CommitIdentity`, `SplitPolicy`) next to the functions that take them.
 *
 * What is NOT here yet, and why: `src/loop/stages/decompose.ts`, every `src/loop/engine.ts` change,
 * `src/spend/meter.ts`'s `hold`/`release`, `src/checkpoint/store.ts`'s `writeCache`,
 * `src/sandbox/seatbelt.ts`'s child deny list and `src/orchestrate/preflight.ts` belong to the
 * engine-wiring wave and to the coordination waves this design consumes (§0.1). This slot is the
 * pure half: everything below is unit-testable over a temp repo with no engine, no session and no
 * network.
 */

// ---------------------------------------------------------------------------------------
// Contract types (§4.1; they move to `src/core/types.ts // contract 1.5` after coordination 1.4)
// ---------------------------------------------------------------------------------------
export type {
  AgentRef,
  AgentRole,
  AgentRow,
  AgentSpec,
  AskFn,
  Clock,
  CommitIdentity,
  DemandReason,
  DraftAgent,
  DraftSplit,
  GateReason,
  LandAttempt,
  Manifest,
  NormalizedSplit,
  NormalizeResult,
  RankedSplit,
  RejectedOption,
  RunGit,
  RunGitOptions,
  SplitKind,
  SplitPolicy,
  SyncedDirtyEntry,
  AgentState,
  VerifyResult,
} from './types.js';
export { DEFAULT_SPLIT_POLICY } from './types.js';

// §2.2 / §3.7: one canonical form for the adoption key and the manifest checksum
export { canonicalManifestInput, checksumOf, manifestIdOf } from './canonical.js';
export type { ManifestIdInput } from './canonical.js';

// ---------------------------------------------------------------------------------------
// The planner (§3): gate → enumerate → normalise → rank, with `own` underneath all of it
// ---------------------------------------------------------------------------------------
export {
  collapseOwn,
  containsGlob,
  dedupeContained,
  disjoint,
  matchesOwn,
  overlaps,
  ownStrings,
  ownsPath,
  parseOwnGlob,
  validateOwnList,
} from './split/globs.js';
export type { DisjointResult, OwnGlob, OwnGlobKind, ValidateOwnOptions, ValidateOwnResult } from './split/globs.js';

export { gateReasonText, splitGate } from './split/gate.js';
export type { GateInput, GateVerdict } from './split/gate.js';

export { enumerateSplits, prefixTree, topLevelDirs, PREFIX_TREE_MAX, PRELUDE_SLUG } from './split/enumerate.js';
export type { EnumerateInput } from './split/enumerate.js';

export { hasDependencyCycle, mergeAgentFields, normalizeSplit, AGENT_WALL_FLOOR_MS, SLUG_RE } from './split/normalize.js';
export type { Mergeable, MergedFields, NormalizeInput } from './split/normalize.js';

export {
  buildDecomposeQuestions,
  buildDecomposeState,
  buildRankQuestions,
  buildRankState,
  optionKeyOf,
  planDecomposeQuestions,
  rankScoreId,
  selfContainedId,
  DECOMPOSE_STATE_LIMITS,
  MAX_DECOMPOSE_QUESTIONS,
  MAX_RANK_QUESTIONS,
  OPTION_KEY_OF,
  RANK_LEVELS,
  RANK_STATE_LIMITS,
  SPLIT_ESCAPE,
  SPLIT_KIND_OF,
  WHICH_SPLIT,
} from './split/questions.js';
export type { DecomposeQuestionPlan, DecomposeStateInput, RankAgentInput } from './split/questions.js';

export { applyDropRule, rankLandingOrder, rankSplits } from './split/rank.js';
export type { DropContext, DropResult, LandingAgent, RankInput } from './split/rank.js';

// §5.1: the verification set, resolved by code
export { resolveVerification, verifyForOwn, NO_VERIFICATION_REASON, VERIFY_COMMAND_CHARS } from './verify.js';
export type { VerifyResolution, VerifyResolveInput, VerifySource } from './verify.js';

// §3.7: the decomposition record
export { buildManifest, dockBranchOf, manifestPath, nodeManifestIo, readManifest, sameDelegation, writeManifest } from './manifest.js';
export type { BuildManifestInput, BuildResult, ManifestIdContext, ManifestIo, ReadResult, WriteResult } from './manifest.js';

// ---------------------------------------------------------------------------------------
// Isolation and the commit (§2.3, §2.6) — the harness commits, or nothing in §5 executes [G1]
// ---------------------------------------------------------------------------------------
export { applyDirtySnapshot, carriedPaths, cleanProbe, dirtyPaths, dirtySnapshot, parseStatusZ, statusEntries } from './worktree.js';
export type { DirtyFile, StatusZEntry, WorktreeFacade } from './worktree.js';

export { commitMessage, commitStep, computeAddSet, syncedDirtyEntry, uncommitLast, SUMMARY_CHARS } from './commit.js';
export type { AddSet, AddSetInput, CommitStepOptions, CommitStepResult } from './commit.js';

// ---------------------------------------------------------------------------------------
// The critic and the landing queue (§5), and the watchdog (§7.1)
// ---------------------------------------------------------------------------------------
export {
  buildIncludeDropQuestion,
  checkHardRules,
  countAssertions,
  flakyFlag,
  hasConflictMarkers,
  matchesTestGlob,
  outsideOwn,
  parseVerifyCounts,
  tailLines,
  totalCount,
  BRANCH_MOVED,
  HARD_RULES,
} from './critic.js';
export type { DiffFile, HardRuleInput, HardRuleResult, HardRuleViolation, IncludeDropQuestion, OutsideOwnInput, VerifyHistoryEntry } from './critic.js';

export {
  acquireLandLock,
  appendLandLog,
  applyLandResult,
  applyLandStep,
  diffNames,
  landLockHeldMessage,
  landLockPath,
  landLogLine,
  landLogPath,
  mergePinned,
  nextLandStep,
  parseLandLock,
  pinBranch,
  queueOrder,
  readLandLock,
  rebaseOnDock,
  recheckPin,
  releaseLandLock,
  restoreDock,
  revListCount,
  DOCK_CLEAN_FLOOR,
  LAND_LOCK_FILE,
  LAND_LOCK_MAX_AGE_MS,
  LAND_LOG_FILE,
  ORCHESTRATE_SUBDIR,
} from './land.js';
export type { AcquireLandLockOptions, AcquireLandLockResult, LandLock, LandLockHandle, LandQueueState, LandStep, QueueAgent, RestoreDockResult } from './land.js';

export { detectStall } from './stall.js';
export type { HeartbeatSample, StallSignal, StallVerdict } from './stall.js';
