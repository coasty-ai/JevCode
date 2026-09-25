/**
 * The step loop (DESIGN.md §6), the step commit rule (§9.1), shutdown (§11), the
 * generator-only condition (§13) and the jev-only mode (docs/JEV-ONLY.md), all selected by
 * `opts.mode`. Stage results accumulate in a per-step draft; `plan`, `window` and the loop
 * detector are replaced only at the commit point, so a final checkpoint taken from any entry
 * point is never half-applied.
 *
 * jev-only runs the jev-on pipeline (replan, intent, context, risk, execute, judge) with the
 * propose stage swapped for `opts.synthesizer.synthesize(ctx)`: no generator is called, so no
 * `generator:*` events fire and no generator.jsonl row is written for the step; the
 * synthesizer's progress arrives as `synth` events through the engine's redacting emit (one
 * transcript.log line each) and its Jev questions go through the engine's recorded ask.
 *
 * Concurrent modules (checkpoint/*, workspace/*, sandbox/*) are reached through `EngineDeps`
 * with dynamic imports as the default, so this module compiles and tests with fakes.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join, sep } from 'node:path';
import { createEmitter } from '../core/events.js';
import { sha12 } from '../core/hash.js';
import { toJson } from '../core/json.js';
import { clip } from '../core/text.js';
import { monotonicNow, nowIso, percentile, sleep } from '../core/time.js';
// TUI-DESIGN §8.6 (F7): the steer bounds are defined once, next to PendingDirective; re-exported below under the engine's names
import { DEFAULT_COMMIT_IDENTITY, DIRECTIVE_MAX_CHARS, PENDING_DIRECTIVES_MAX } from '../core/types.js';
import type { AskResult,
  AckOutcome,
  Action,
  ActionOutcome,
  AgentRef,
  OrchestrationOptions,
  PlanDraft,
  SandboxLevel,
  SandboxProfile,
  Answer,
  BlockingAnswer,
  BlockingRequest,
  CheckpointState,
  ConfirmOutcome,
  CancelledGeneration,
  CheckpointStore,
  ConfirmRequest,
  Decider,
  Decision,
  DeliverableMessage,
  Engine,
  EngineEmitter,
  EngineEvent,
  EngineMode,
  FastPathReason,
  EngineOptions,
  EngineStatus,
  EndOptions,
  FileView,
  GenerateRequest,
  GenerateResult,
  GeneratorCallRecord,
  GitState,
  HarnessProblem,
  Intent,
  InterruptReason,
  JevCostBasis,
  IntentAnswer,
  InterruptedDetail,
  JevRequestRecord,
  Json,
  JsonObject,
  JudgeResult,
  PauseOptions,
  EngineRunPhase,
  MessageDisposition,
  PausePoint,
  PausePointReason,
  PendingDirective,
  Plan,
  PlanSnapshot,
  StepFastPath,
  StepProposer,
  StepVerifySummary,
  Proposal,
  Question,
  ReplanDirective,
  RetryInfo,
  RiskAssessment,
  RunCounters,
  RunGitMeta,
  RunLimits,
  RunClaimRow,
  RunMeta,
  RunResult,
  SampleOptions,
  Sandbox,
  SandboxCreateOptions,
  SerializedError,
  SignalName,
  SpendSource,
  StageName,
  SteerResult,
  StepCoord,
  StepRecord,
  StepTiming,
  StepUsage,
  StopReason,
  StoppedAt,
  SubworkEntry,
  SynthSubwork,
  SynthesisContext,
  Synthesizer,
  TargetInfo,
  TestCounts,
  TokenUsage,
  UiLabel,
  UndoLogEntry,
  WindowEntry,
  Workspace,
  WorkspaceInfo,
  // contract 1.4 (COORDINATION-DESIGN §8, §12.0.3): the context policy's shapes, now in the core contract
  ContextUsage,
  FileCacheEntry,
  FileMemory,
  HistoryEntry,
  RecentStepsUsage,
  // docs/AGENT-LOOP-DESIGN.md §2.2, §15 S1: the agent seam's contract — the driver is reached only through these
  AgentContext,
  AgentDriver,
  AgentDriverFactory,
  AgentGate,
  AgentGenerateHooks,
  AgentNext,
  AgentObservation,
  LoopTrip,
  StepAgentSummary,
  ToolCallDelta,
} from '../core/types.js';
import { AbortError, CheckpointError, ConfigError, GeneratorResponseError, JevCodeError, JevHttpError, JevModelDriftError, JevResponseError, ProviderHttpError, isAbortError, isBudgetError, isJevCodeError, toJevCodeError, type BudgetKind } from '../errors.js';
import type { DiskError } from '../checkpoint/store.js';
import { CHECKPOINT_FILES, CONTEXT_SUMMARY_FILE, attachDegradeListener, classifyDiskError, outputFileName } from '../checkpoint/store.js';
import { fileMemoryFromPostImage, writePostImages, writePreImages, type ImageSource, type PostImage, type PreImageResult } from '../checkpoint/images.js';
import { hasContextStore, readContextExtension, type ContextCheckpointExtension } from '../checkpoint/types.js';
import { CACHED_SAMPLES_MAX, CACHED_SAMPLE_MAX_CHARS, PARTIAL_TEXT_MAX_CHARS, REPLAY_HASH_MAX_FILES, hashTargets, parseStepCache, promptHashOf, proposalPaths, stepCacheName, stepCacheRel, stepCacheSupersededName, verifyTargets, type CachedSample, type StepCache } from '../checkpoint/replay.js';
// docs/COORDINATION-DESIGN.md §8: the generator's relaxed context (Jev's window is untouched — two windows, §8.1)
import { compactCode, compactionDue, isContextSummary, rankKept, type CompactionTrigger, type KeptItem } from './context/compaction.js';
import { extractKept, readKeptItems } from './context/kept.js';
import { FilesInView, boundMemory, dropFile, evictFiles, forgetFile, noteShown, rememberFile, touchFile, workspaceFilesInViewDeps } from './context/context-cache.js';
import { buildHistoryEntry, foldHistoryRecord, foldableCount, needsOutputFile, outputRefFor, outputView, parseOutputRef, planHistory, pushHistory, renderHistory, seedHistoryEntry, tierText, type HistoryPlan, type OutputView } from './context/history.js';
import { AGENT_MEM_BYTES, MIN_FREE_BYTES, ORCHESTRATION_DEPTH_MAX } from '../core/limits.js';
import { CONTEXT_BUDGET_MIN_CHARS, FILE_CACHE_MAX_ENTRIES, HISTORY_MID, HISTORY_SHARE, HISTORY_WHOLE_HEAD, HISTORY_WHOLE_TAIL, OUTPUT_READ_PREFIX, resolveContextPolicy, type ResolvedContextPolicy } from './context/limits.js';
import { computeContextUsage, contextWarnCrossed, restoredContextUsage } from './context/meter.js';
import { synthContextText } from './context/synth-view.js';
import type { ContextReadHooks, ContextSummary } from './context/types.js';
import { acquireRunLock, releaseRunLock } from '../session/lock.js';
import { seedNoticeText } from '../session/seed.js';
// [D6]: `sessionRemainingUsd`'s third argument (heldUsd) landed with d8490fa, so the engine reads the ONE
// definition instead of the local twin it carried while that was in flight.
import { nextBudgetWarn, seedAnnounced, sessionRemainingUsd, stepsLeftEstimate, suggestedSpendCapUsd, type BudgetPct } from '../tui/budget/lines.js';
import { checkpointDegradedDetail, driftDetail, keyRejectedDetail } from '../tui/blocking/lines.js';
import { EQUIVALENT_IDS, equivalentIdsRow, equivalentJevModel, jevModelMatches, normaliseModelId, sameJevWeights } from '../jev/providers.js';
import { VERSION } from '../version.js';
import { headDriftWarning, headMoved, notRepoState, probeGitState as realProbeGitState, toRunGitMeta } from '../workspace/gitstate.js';
import { runGit } from '../workspace/git.js';
import { decisionConfidence, decisionProbability } from '../jev/confidence.js';
import { assertQuestionBatch } from '../jev/questions.js';
import { summariseAction } from '../provider/actions.js';
import { buildPrompt, buildSplitMessage, buildSystemPrompt, memoryIndexChars, splitToolsFor, PROPOSE_SPLIT_TOOL_NAME, type PromptBuild, type PromptContextView, type PromptHints, type PromptInput, type PromptMemoryBuild } from '../provider/prompts.js';
// contract 1.6 (IMPORT-DESIGN §2.10.4, §7.5 row 42): the per-step rule/topic matcher
import { selectMemory } from './context/memory.js';
// contract 1.5 (§3.4 rule 9): a COUNT of secret hits, never a value
import { detectSecrets } from '../core/redact.js';
import { linkedAbort } from '../core/abort.js';
import { DEFAULT_CONTEXT_COMPACTION, lookupPricing } from '../config/defaults.js';
import { formatTranscriptItem, itemsFromEvent, sanitizeStream } from '../tui/plain.js';
import { stepTimeline, writeTimelineFile } from '../perf/timeline.js';
import { checkBudgets, armWallDeadline, type WallDeadline } from './budget.js';
import { INTENT_UNRESOLVED_SIGNATURE, computeSignatures, createLoopDetector, directiveMove, loopTripText, signatureKind, type LoopDetector } from './loopdetect.js';
import { PLAN_MAX_HARNESS_PROBLEMS, applyPlanDraft, boundHarnessProblems, emptyPlan, newClaims, type ClaimEvidence } from './plan.js';
import { buildCommonState, isChangeAction, testsCurrent, type Redact } from './state.js';
import { assembleRunResult, classifyAbort, exitCodeFor, isFinishedStop, serializeError, stopTranscriptLine, tokenSeriesOrZeros } from './stop.js';
import { buildWindowEntry, foldStepRecord, pushWindow } from './window.js';
import { completionDecision, isComplete, isCompleteByFact, type CompletionFactInput } from '../jev-modes/stages/complete.js';
// contract 1.9 (Fastlane) §7.5 — the engine seam of the router table: the switch (§0.3), the per-step commit of the
// token and the ledger (§2.6, §5.2). `src/loop/routers.ts` owns all three; the engine calls them and nothing else.
import { commitStepRouters, discardStepRouters, routersOn, stepTokenFor } from './routers.js';
import { prefilterCandidates, runContextStage } from '../jev-modes/stages/context.js';
import type { ContextAskPolicy } from '../jev-modes/stages/context.js';
// contract 1.5 (ORCHESTRATION-DESIGN §3, §8.2 D1 item 15): the decompose stage
import { checkpointOrchestration, decomposeShutByOptions, measureRepoFacts, parseSplitDraft, runDecomposeStage, splitPrefixTree, type DecomposeFacts, type DecomposeStageContext } from './stages/decompose.js';
import { runExecuteStage } from './stages/execute.js';
// contract 1.9 (Fastlane) docs/LLM-LOOP-DESIGN.md §4 (route R9): the bounded sieve fast path — a pure engine-side
// predicate and budget here, the round itself behind the synth facade.
import { declinedRecord, fastPathBudget, fastPathRunWallCapMs, fastPathStage1Free, fastPathStage1Workspace, firedRecord } from '../jev-modes/stages/fastpath.js';
import { FastPathRunner, fastPathFailingIds, fastPathFingerprint, fastPathSuspects } from '../jev-modes/synth/search/fastpath.js';
import type { FastPathBudget, FastPathRunState } from '../jev-modes/synth/search/fastpath.js';
import { detectLayout } from '../jev-modes/synth/search/index.js';
import { isRepositoryWorkspace } from '../jev-modes/synth/oracle/index.js';
import { synthesizerHandles } from '../jev-modes/synth/index.js';
// contract 1.9 (Fastlane) §3.2: a hedge twin's sample index carries its origin — the one fact `noteSampleStart` needs
// to tell "a second copy of a sample of the open round" from "a new round"
import { LLM_DEADLINE_ADAPT, hedgeOriginOf } from '../jev-modes/synth/llm/source.js';
import { hedgedCall, providerOrderFor, s2Mode } from '../jev-modes/synth/llm/hedge.js';
import { warmPlaneEnabled } from '../jev-modes/synth/warm/index.js';
import { isTestCommand, scopeUsable } from '../workspace/tests.js';
import { runIntentStage, INTENT_FALLBACK, PLAN_STALE_THRESHOLD, type IntentStageResult } from '../jev-modes/stages/intent.js';
import { codeJudge, ledgerGoalsOf } from './judge-code.js';
import { runJudgeStage } from '../jev-modes/stages/judge.js';
// docs/AGENT-LOOP-DESIGN.md §2.1, §2.2 (slice S4): the agent-mode propose stage and the engine seam's pure helpers
import {
  AGENT_MAX_BLOCKS,
  AGENT_MAX_BLOCKS_LINE,
  AGENT_MAX_LOOP_NUDGES,
  AGENT_OUTPUT_PARTS_MAX_BYTES,
  AGENT_SEEDED_STEP_REFUSED,
  AGENT_STATE_MAX_BYTES,
  changedSincePre,
  createAgentStreamTap,
  createOutputPartLedger,
  destructiveCoverage,
  destructiveNote,
  isAgentRefusal,
  isOutputPart,
  isUnscopedGreenRun,
  recordedTestCommand,
  ruleRiskAssessment,
  runAgentStage,
  stepChangeSet,
  writeOutputPart,
} from './stages/agent.js';
import { isReplyOnlyRun } from '../core/agent-run.js';
import { ABSENT_DECIDER_MODEL } from '../jev/absent.js';
import { settingIsExplicit } from '../config/resolve.js';
import { runProposeStage, type ProposeStageResult } from '../jev-modes/stages/propose.js';
import { runReplanStage } from '../jev-modes/stages/replan.js';
import { createCachingDecider, type CachingDecider } from '../jev/cache.js';
import { runSynthStage } from '../jev-modes/stages/synth.js';
import { computeTargets, isOwnershipRefusal, ownershipRefusal, runRiskStage, MATCHES_INTENT_THRESHOLD, SCOPE_FIGHT_AFTER, type VerifiedCompletion } from '../jev-modes/stages/risk.js';
// contract 1.5 (ORCHESTRATION-DESIGN §8.1 rule 2): orchestration is imported through the ONE facade, never a file below it.
import {
  commitStep,
  computeAddSet,
  manifestPath,
  nodeManifestIo,
  nodePreflightProbe,
  preflight,
  type PreflightProbe,
  readManifest,
  resolveVerification,
  sameDelegation,
  DEFAULT_SPLIT_POLICY,
  type DraftSplit,
  type GateReason,
  type Manifest,
} from '../orchestrate/index.js';
import { escapedLine, escapedPaths, landPreflightOffer, launchOverlap, launchProposal, mergeAction, seedFor, type LandPreflightOffer, type LaunchAnswer, type LaunchInput } from './launch.js';
// contract 1.4 (W2b), COORDINATION-DESIGN §4 / §5 / §6: the engine's ONE import of the coordination ledger.
// `createCoordination` returns null when there is no handle, which is the whole of "coordination off".
import { SUBWORK_MAX, coordinates, createCoordination, type CoordinateOutcome, type CoordinationRuntime, type HeartbeatBase, type HeartbeatDynamic } from './coordination.js';

// ---------------------------------------------------------------------------------------
// Dependency injection (concurrently written modules)
// ---------------------------------------------------------------------------------------

export interface ResumeLoad {
  meta: RunMeta;
  state: CheckpointState;
  recoveredFrom: 'state' | 'prev';
  /** steps.jsonl records with step > the checkpointed step (§9) */
  foldedSteps: StepRecord[];
  /** stopReason as checkpointed, when the loader already cleared `state.stopReason` */
  previousStopReason?: StopReason | null;
  /** true when the loader already folded the steps into `state`, cleared stopReason and incremented resumes */
  prepared?: boolean;
  /** store bound to the run dir, when the loader created one */
  store?: CheckpointStore;
}

export type CheckpointStoreFactory = (runsDir: string, runId: string, redact: Redact) => CheckpointStore;
/** TUI-DESIGN §12.1 / §15 item 8: `gitState` is the run-start probe; given, createWorkspace performs zero spawns. */
export type WorkspaceFactory = (root: string, runDir: string, deps: { sandbox: Sandbox; secretPaths: readonly string[]; redact: Redact; gitState?: GitState }) => Promise<Workspace>;
export type SandboxFactory = (opts: SandboxCreateOptions) => Sandbox;
/** TUI-DESIGN §12.1 (D7): the two unsandboxed spawns before the sandbox exists; injectable so tests need no git. */
export type GitProbe = (root: string) => Promise<GitState>;
export type ResumeLoader = (runsDir: string, runId: string, redact: Redact, store: CheckpointStore) => Promise<ResumeLoad>;

export interface EngineDeps {
  createCheckpointStore?: CheckpointStoreFactory;
  createWorkspace?: WorkspaceFactory;
  createSandbox?: SandboxFactory;
  newRunId?: (now: Date) => string;
  /**
   * default: checkpoint/resume.ts `loadForResume(runsDir, runId, { redact })`; when a store
   * factory is injected without a loader, `store.load()` + `store.readStepsAfter()` is used.
   */
  loadForResume?: ResumeLoader;
  /** default: workspace/gitstate.ts probeGitState (TUI-DESIGN §12.1); a probe that rejects reads as `git-missing` */
  probeGitState?: GitProbe;
  /**
   * contract 1.4 (W2b), ORCHESTRATION-DESIGN §3.6: the resource pre-flight's seam. Default `nodePreflightProbe()`,
   * which reads `statfs`, `os.freemem()`, `availableParallelism()`, `du -sk` and the soft `RLIMIT_NOFILE` — five facts
   * that differ per machine and per minute, so the P9 delegate pause point and the §8.3 row-12 gate could not be
   * driven end to end without injecting them. `preflight` itself was already pure; this was the last impure edge on
   * the decompose path, and it sat INSIDE `decomposeFacts` where no `EngineDeps` could reach it.
   */
  preflightProbe?: PreflightProbe;
}

interface ResolvedDeps {
  preflightProbe: PreflightProbe;
  createCheckpointStore: CheckpointStoreFactory;
  createWorkspace: WorkspaceFactory;
  createSandbox: SandboxFactory;
  newRunId: (now: Date) => string;
  loadForResume: ResumeLoader;
  probeGitState: GitProbe;
}

// Real sibling modules (static imports: esbuild bundles them; tests still inject fakes via EngineDeps).
import { createCheckpointStore as realCreateCheckpointStore } from '../checkpoint/store.js';
import { newRunId as realNewRunId } from '../checkpoint/run-id.js';
import { loadForResume as realLoadForResume, raiseAgentTranscriptSeq } from '../checkpoint/resume.js';
import { createSandbox as realCreateSandbox } from '../sandbox/run.js';
import { createWorkspace as realCreateWorkspace } from '../workspace/files.js';

async function resolveDeps(deps: EngineDeps): Promise<ResolvedDeps> {
  const createCheckpointStore: CheckpointStoreFactory =
    deps.createCheckpointStore ?? ((runsDir, runId, redact) => realCreateCheckpointStore(join(runsDir, runId), redact));
  const newRunId = deps.newRunId ?? realNewRunId;
  const createSandbox: SandboxFactory = deps.createSandbox ?? realCreateSandbox;
  const createWorkspace: WorkspaceFactory = deps.createWorkspace ?? realCreateWorkspace;
  let loadForResume = deps.loadForResume;
  if (!loadForResume) {
    if (deps.createCheckpointStore) loadForResume = storeBasedLoadForResume;
    else {
      loadForResume = async (runsDir, runId, redact) => {
        const r = await realLoadForResume(runsDir, runId, { redact });
        return { meta: r.meta, state: r.state, recoveredFrom: r.recoveredFrom, foldedSteps: r.foldedSteps, previousStopReason: r.previousStopReason, prepared: true, store: r.store };
      };
    }
  }
  const probeGitState: GitProbe = deps.probeGitState ?? ((root) => realProbeGitState(root));
  // §3.6: resolved ONCE per engine, not once per gate — an injected probe must be the same object across the run or
  // a test cannot count its calls, and `nodePreflightProbe()` is a closure bag with no state worth rebuilding.
  const preflightProbe: PreflightProbe = deps.preflightProbe ?? nodePreflightProbe();
  return { createCheckpointStore, createWorkspace, createSandbox, newRunId, loadForResume, probeGitState, preflightProbe };
}

async function storeBasedLoadForResume(_runsDir: string, _runId: string, _redact: Redact, store: CheckpointStore): Promise<ResumeLoad> {
  const { meta, state, recoveredFrom } = await store.load();
  const foldedSteps = await store.readStepsAfter(state.step);
  return { meta, state, recoveredFrom, foldedSteps };
}

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z2-7]{8}$/;
const RUN_DIR_ATTEMPTS = 5;
/** Bound on the final checkpoint phase in stop()/shutdown (§11). */
export const SHUTDOWN_CHECKPOINT_BOUND_MS = 5_000;
export const SYNTH_STATE_MAX_BYTES = 64 * 1024;
const CONSECUTIVE_STAGE_FAILURE_LIMIT = 3;
/** contract 1.1 (TUI-DESIGN §15 item 15, §8.6): at most 8 queued steers of at most 600 chars each — one definition (core/types.ts, F7) */
export const MAX_PENDING_DIRECTIVES: number = PENDING_DIRECTIVES_MAX;
export { DIRECTIVE_MAX_CHARS };
/** TUI-DESIGN §8.6 annotate(): a renderer-originated line is clipped at 600 and its TUI-only body at 12,000 (through sanitizeStream) */
export const ANNOTATE_TEXT_MAX_CHARS = 600;
export const ANNOTATE_DETAIL_MAX_CHARS = 12_000;
/**
 * contract 1.7 item 2 (TUI-DESIGN-4 §3.5 D-W, edge 2): `annotateBlock` logs at most this many BODY rows, then one
 * `… +N more rows`. A 42-row `/config` issued while a run is live would otherwise be 42 events through the redacting
 * emit and 42 lines in `transcript.log`, which is a support artefact, not a pager mirror.
 */
export const BLOCK_LOG_MAX = 24;
/** TUI-DESIGN §13.2 / §13.3: `paused: jev unreachable` auto-retries after 30 s, doubling to 5 min across consecutive pauses */
export const JEV_UNREACHABLE_RETRY_MS = 30_000;
export const JEV_UNREACHABLE_RETRY_MAX_MS = 300_000;
/** TUI-DESIGN §15 item 9: `CheckpointState.undoLog` keeps at most 20 entries */
export const UNDO_LOG_MAX = 20;
/** TUI-DESIGN §15 item 3: `StepRecord.planAfter` lists are bounded to 20 × 200 chars */
const PLAN_SNAPSHOT_ITEMS = 20;
const PLAN_SNAPSHOT_CHARS = 200;
/** TUI-DESIGN §9.5: the `raise:` suggestion of a token_cap stop rounds up to the next 10k tokens above what was used */
const TOKEN_CAP_RAISE_STEP = 10_000;
/** TUI-DESIGN §13.3: a 429 whose message names the account's spend/credit limit is a spend-limit pause, not a rate limit */
const SPEND_LIMIT_RE = /spend|credit|billing|quota|insufficient/i;
/** TUI-DESIGN §15 item 6: a reviewer note is one line of at most 600 chars */
const REVIEWER_NOTE_MAX = 600;
/** contract 1.4 (COORDINATION-DESIGN §7.2): finish() waits this long for the pause-now cache write before `replayable` is read as false */
export const PAUSE_CACHE_BOUND_MS = 2_000;
/** §4.3: `released.changed` is bounded at 64 entries by the lease record's own cap */
const LEASE_CHANGED_MAX = 64;
/** §3.3: `touchedRecent` — the union of the last three steps' post images, ≤ 96 paths */
const TOUCHED_RECENT_KEEP = 96;
/** contract 1.4 (§5.3, §10): a peer's label inside `PausePoint.by` is clamped to this many chars of the id grammar */
export const PEER_LABEL_MAX = 32;
/** §5.3: `peer:<sid8>` — the last 8 chars of the sender's session id */
const PEER_SID_CHARS = 8;
/** the `by` grammar: [A-Za-z0-9._-] only, ≤ PEER_LABEL_MAX chars, never empty (a stripped label reads `unknown`) */
function peerLabel(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, PEER_LABEL_MAX);
  return clean.length > 0 ? clean : 'unknown';
}

/**
 * TUI-DESIGN §13.3: what a failing stage asks for, before the loop top installs it. The id and the auto-retry interval
 * are allocated only at install time (`installBlock`), so a request handleStepError discards (an action already ran, a
 * pane is already up) advances neither the blocking sequence nor the `jev-unreachable` backoff.
 */
type BlockSpec = Omit<BlockingRequest, 'id' | 'retryInMs'> & { autoRetry?: boolean };

// ---------------------------------------------------------------------------------------
// Stage context (what src/loop/stages/*.ts and src/jev-modes/stages/*.ts see)
// ---------------------------------------------------------------------------------------

export interface AskOutcome {
  answers: Record<string, Answer>;
  rows: Decision[];
  latencyMs: number;
}

export interface StageContext {
  readonly runId: string;
  readonly step: number;
  readonly mode: EngineMode;
  readonly task: string;
  readonly limits: RunLimits;
  readonly signal: AbortSignal;
  readonly redact: Redact;
  readonly generation: { temperature: number | null; maxTokens: number };
  readonly workspace: Workspace;
  readonly sandbox: Sandbox;
  readonly workspaceInfo: WorkspaceInfo;
  /** git-status changed files at step start */
  readonly changedFiles: readonly string[];
  readonly createdThisRun: ReadonlySet<string>;
  /** targets computed by the risk stage (jev-on) or before execute (jev-off) */
  patchTargets: readonly TargetInfo[];
  /**
   * contract 1.9 (Fastlane) §0.3 / §7.5 seam (b): `EngineOptions.routers`, lifted off the run and handed to
   * `routersOn(ctx.mode, ctx.routers)` at the four routed sites. Absent = the caller pinned nothing and
   * `JEVCODE_ROUTERS` decides (`routersEnabled`); the `jev-on` gate is checked first and no switch passes it.
   */
  readonly routers?: 'on' | 'off';
  /** how much of the candidate set the context stage asks Jev about; absent = `LEGACY_CONTEXT_ASK` (always ask); the product passes `PRODUCT_CONTEXT_ASK` */
  readonly contextAsk?: ContextAskPolicy;
  now(): number;
  wallRemainingMs(): number;
  emit(e: EngineEvent): void;
  /**
   * The one metered, recorded path to the decider. `signal` is contract 1.9 (Fastlane) §7.5 seam (a): a
   * **per-call** signal a speculative router hands in, so that an ask it has already dropped is cancelled AND
   * charges nothing. Absent on every non-routed site, where the call is the pre-1.9 one byte for byte.
   */
  ask(stage: StageName, state: JsonObject, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void, signal?: AbortSignal): Promise<AskOutcome>;
  generate(req: GenerateRequest, attempt: number): Promise<GenerateResult>;
  noteMalformed(attempt: number): void;
  startCandidateRefresh(): void;
  /** docs/COORDINATION-DESIGN.md §8.3 / §8.4 (W2 item 21): the zero-cost read and the `jevcode:outputs/` pseudo-path; absent in fakes */
  contextReads?: ContextReadHooks;
  /**
   * contract 1.5 (ORCHESTRATION-DESIGN §2.5): this engine's place in a delegation, so the stages that carry a child
   * difference read one field instead of five — the risk stage's `own` refusal (§2.4 belt 2) and the propose stage's
   * research tool schema (§2.5(b)). Absent on every run without `EngineOptions.orchestration`, which is why nothing
   * here can change an ordinary run.
   */
  readonly orchestration?: OrchestrationOptions;
}

// ---------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------

/**
 * contract 1.9 (Fastlane) docs/LLM-LOOP-DESIGN.md §0.3: the fast path's effective switch.
 *
 * `'auto'` in `jev-on` and `'off'` in every other mode — the engine derives the default, so there is no `src/config`
 * and no `src/cli` change. `JEVCODE_FASTPATH=off|auto` fills an **absent** option, which is how a bisect and a
 * worker process turn it off without rebuilding; it is read here for the same reason `JEVCODE_WARM` is read inside
 * `src/jev-modes/synth/warm/plane.ts`. Any other value is ignored rather than throwing: an env typo must not end a run.
 *
 * **The explicit option wins** (§7.5 seam (b); it used to read the env FIRST in
 * both directions). An exported `JEVCODE_FASTPATH=off` ran `jev-on-next` disarmed while `summary.json` recorded
 * `'auto'`, and `JEVCODE_FASTPATH=auto` armed the `jev-on-next-nofast` CONTROL while it recorded `'off'` — the
 * arm's own row was not the truth, and nothing in the output said so. `routersEnabled` (src/jev/router.ts) has the
 * same polarity, so the two mechanism switches now behave alike.
 */
export function resolveFastPathOption(mode: EngineMode, option: 'auto' | 'off' | undefined): 'auto' | 'off' {
  if (option !== undefined) return option === 'auto' && mode === 'jev-on' ? 'auto' : 'off';
  const env = process.env['JEVCODE_FASTPATH'];
  if (env === 'off') return 'off';
  return mode === 'jev-on' ? 'auto' : 'off';
}

/**
 * contract 1.9 (Fastlane) §4.3: what stage 1 agreed to. Separated from the round so the cheap predicate stays outside
 * any stage (a decline must cost nothing and emit nothing) while the round runs inside `this.stage('propose', …)`.
 */
interface ArmedFastPath {
  runner: FastPathRunner;
  state: FastPathRunState;
  budget: FastPathBudget;
  fingerprint: string;
  tRunMs: number;
}

interface StepDraft {
  step: number;
  startedAt: string;
  t0: number;
  intent: IntentStageResult | null;
  contextFiles: string[];
  proposal: Proposal | null;
  risk: RiskAssessment | null;
  /**
   * contract 1.9 (Fastlane) §2.4 / §7.5 seam (c): which verdict actually stood at the risk stage, and whether the
   * harm ask was dropped or failed. `RiskStageResult` returns both only with routers on (§2.4's code-first gate);
   * `commit()` copies them onto `StepRecord.riskSource` / `jevUnavailable`, so both stay absent with routers off.
   */
  riskSource: 'code' | 'jev' | null;
  jevUnavailable: boolean | null;
  matchesIntent: number | null;
  outcome: ActionOutcome | null;
  output: string;
  changedFiles: string[];
  tests: { command: string; parsed: TestCounts | null; allPassed: boolean | null } | null;
  created: string[];
  judge: JudgeResult | null;
  completion: number | null;
  claims: string[];
  claimsDropped: number;
  claimProbabilities: Map<string, number> | null;
  decisions: Decision[];
  jevRequests: JevRequestRecord[];
  generatorRecords: GeneratorCallRecord[];
  usage: StepUsage;
  /**
   * imagesMs: TUI-DESIGN §12.3 pre + post images, inside harnessMs; null when the step took none.
   *
   * decomposeMs: contract 1.5 (§4.1 [D13]) — the `decompose` stage's own wall, inside harnessMs; 0 when the gate was shut.
   *
   * `jevMs` is what the decider *reports* (`AskResult.latencyMs`) — the client's cost basis, the number jev.jsonl
   * and `/jev` show. `jevWallMs` is the wall the engine actually spent inside `decider.ask`, measured here.
   * HARNESS-NEXT-DESIGN §4.4 / §5: `harnessMs` subtracts the larger of the two, because a decider that does its
   * work in-process and reports `latencyMs: 0` (every mock and stub, `src/jev/mock.ts`, `src/bench/stub-decider.ts`,
   * `src/jev/off.ts`) would otherwise spend the 50 ms harness budget on the test double's own CPU — which is what
   * made the gate look fixable by making the double faster. The two are within noise of each other for a real HTTP
   * decider, so this only ever tightens the gated number.
   *
   * coordinateMs / coordWaitMs: contract 1.4 (W2b) (COORDINATION-DESIGN §4.2) — the claim gate's own wall, and the
   * inline strict wait INSIDE it. Only the WAIT is subtracted from `harnessMs`, exactly like `confirmMs` and for the
   * same reason S0 subtracts the Jev wall: a step held 40 s for a peer did not spend 40 s of harness, and charging
   * it would make the §13 M9 gate a measure of how busy the other session was. The gate's own sub-2 ms work stays
   * IN `harnessMs`, because that part really is ours.
   */
  timing: { generatorMs: number; jevMs: number; execMs: number; confirmMs: number; imagesMs: number | null; jevWallMs: number; decomposeMs: number; coordinateMs: number; coordWaitMs: number };
  /** docs/LLM-JEV-DESIGN.md §7.5: wall of synthesize() (synth modes); null when the propose stage was the generator's */
  /** contract 1.4 (W2b) (§4.1): what the `coordinate` gate saw and decided; copied onto `StepRecord.coord` at commit */
  coord: StepCoord | null;
  synthMs: number | null;
  /** the Jev latency spent inside synthesize(); `timing.jevMs - synthJevMs` is the shell's share */
  synthJevMs: number;
  /** the same split for the measured ask wall: `timing.jevWallMs - synthJevWallMs` is the shell's measured share */
  synthJevWallMs: number;
  /** docs/LLM-JEV-DESIGN.md §4.8: the in-flight samples of the llm-jev round, for the batch wall in `timing.generatorMs` */
  generatorBatch: { inFlight: number; startedAt: number };
  /**
   * §4.8: true once the step's rows were flushed for the last time (the record committed, or the step discarded). A sample
   * dispatched in this step that ends later cannot ride the step's flush any more: `pushGeneratorRecord` writes its row at once.
   */
  closed: boolean;
  /**
   * docs/LLM-JEV-DESIGN.md §9.3 (llm-jev): the step's verification counts for `StepRecord.verify` — the engine's own tallies
   * of the sample rows it wrote, and what the synthesizer reported through `SynthesisContext.reportVerify` (merged over them).
   */
  verify: {
    samples: number;
    timeouts: number;
    cancelled: number;
    malformed: number;
    reported: Partial<StepVerifySummary> | null;
    /**
     * contract 1.9 (Fastlane) §3.1–§3.4 (F25): what the ENGINE measured about this step's own propose call.
     * Filled only when the S2 switch is on, so an S2-off step's `StepRecord` is byte-identical to HEAD's.
     */
    s2: { ttfbMs: number[]; hedges: number; hedgeWins: number; cacheRead: number; cacheWrite: number };
  };
  /** docs/LLM-JEV-DESIGN.md §9.4 (llm-jev): who proposed — the synthesizer, or the generic per-step fallback (stage 4); null in the other modes */
  proposer: StepProposer | null;
  /** contract 1.9 (Fastlane) §5.2: the fast path's row for this step; null when it never armed (I2: nothing is written then) */
  fastPath: StepFastPath | null;
  /**
   * contract 1.9 (Fastlane) §4.3 T3 / §6 row 14: the scope-usability verdict the TRIGGER saw, snapshotted at propose
   * time. The step's own run overwrites `lastTestRunScopeUsable` at commit, so reading the field there would record
   * run N's verdict beside a `fastPath.reason` that came from run N−1 — on exactly the steps where it matters, the
   * ones whose action is a `run`.
   */
  scopeUsable: boolean | null;
  /** contract 1.9 (Fastlane) §4.4 bound 3: the round's wall, the facade's own clock diff, charged to the step */
  fastPathMs: number;
  /** contract 1.9 (Fastlane) §4.4: the Jev latency spent INSIDE the round (already inside `timing.jevMs`) */
  fastPathJevMs: number;
  generatorFailReason: string | null;
  errorClass: string | null;
  error: { stage: StageName; code: string; message: string } | null;
  interruptedAt: { stage: StageName; reason: InterruptReason } | null;
  jevStagesCompleted: number;
  proposeCompleted: boolean;
  directive: ReplanDirective | null;
  notes: string[];
  executeStarted: boolean;
  executeFinished: boolean;
  /** observed by the loop detector (false for interrupted steps and Jev/provider stage failures) */
  observed: boolean;
  patchTargets: TargetInfo[];
  lastError: unknown;
  // contract 1.4 (COORDINATION-DESIGN §7.2): what a pause-now snapshots
  /** the generator's streamed text and tool-argument fragments of the propose call, ≤ PARTIAL_TEXT_MAX_CHARS (kept for the card, never replayed) */
  partialText: string;
  /** streamed chars of the PROPOSAL's own text only — a sample's chars belong to its generator row, never to the partial proposal (InterruptedDetail.partialChars) */
  partialChars: number;
  /** llm-jev: sample batches started this step (the engine's own fallback round number when the synthesizer names none) */
  llmRounds: number;
  /** llm-jev: the goal and round the samples of this step were fired for, as the synthesizer named them (SampleOptions); null when it named none */
  llmGoal: { goalId: string; round: number } | null;
  /** llm-jev: the samples that arrived this step, for the round cache (≤ CACHED_SAMPLES_MAX) */
  arrivedSamples: CachedSample[];
  /** the step restored its proposal from cache/step-<n>.json (§7.3 step 3) */
  replayed: boolean;
  /** absorbDiscardedTiming ran: this attempt's sample rows carry `discarded: true` (§11 row 41) */
  discarded: boolean;
  /** docs/AGENT-LOOP-DESIGN.md §2.3 / §10: what the driver made of this step (`StepRecord.agent`); null outside agent mode */
  agent: StepAgentSummary | null;
  /** §12: the classifier's gate on this step's mutating call; null unless the step is an agent `act` */
  agentGate: AgentGate | null;
  /** §2.2: a command other than the detected test command changed a workspace file this step — `lastChangeStep` at commit */
  agentChanged: boolean;
}

/** docs/AGENT-LOOP-DESIGN.md §3.4 / §A5: what an agent `act` / `verify` step's images said, for the change set and the note. */
interface AgentImages {
  pre: PreImageResult | null;
  /** the dirty set's size before the command (0 → a null `pre` is "nothing to copy", not a failed copy) */
  dirty: number;
  /** HEAD before the command (null: unborn or no repository) */
  headBefore: string | null;
  /** `changedSincePre` as computed before the post images; null until then */
  preChanged: string[] | null;
}

/** contract 1.4 (§12.0.2): the pause point as decided where the run stopped; finish() completes `resumableAt` / `replayable` / `by` / `end` */
interface PendingPausePoint {
  step: number;
  phase: PausePoint['phase'];
  reason: PausePointReason;
  round: number | null;
  pane?: BlockingRequest['kind'];
  llm?: { goalId: string; round: number; arrived: number[] };
  cache: `cache/step-${number}.json` | null;
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}
/**
 * TUI-DESIGN §9.5: a non-finite `costUsd` means "unpriced" (OpenRouter / Jev `usage.cost` null). `noteUsage` reads the raw
 * value for `budget:unpriced`; every artefact and sum takes this clamped copy, because `JSON.stringify({ costUsd: NaN })` is
 * `{"costUsd":null}` (steps.jsonl / `generator:end` / `--json` would carry null for a `number`) and one NaN poisons the p50
 * behind `stepsLeftEstimate`. spend/meter.ts clamps the same way.
 */
function pricedUsage(u: TokenUsage): TokenUsage {
  return Number.isFinite(u.costUsd) ? u : { ...u, costUsd: 0 };
}
function addUsage(a: TokenUsage, b: TokenUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  // TUI-DESIGN §9.5: an unpriced (non-finite) cost adds nothing — see pricedUsage
  a.costUsd += Number.isFinite(b.costUsd) ? b.costUsd : 0;
  a.calls += b.calls;
}
/**
 * The Jev time `harnessMs` is charged for: the larger of what the decider reported and what the engine measured
 * inside `decider.ask`. HARNESS-NEXT-DESIGN §4.4 — a mock, a stub or the `--jev off` double reports `latencyMs: 0`
 * and does its work on this thread, so charging `jevMs` alone hands the whole of the double's CPU to the gated
 * harness budget. For a real HTTP decider the two agree to within the await, so nothing recorded moves.
 */
function jevChargedMs(draft: Pick<StepDraft, 'timing'>): number {
  return Math.max(draft.timing.jevMs, draft.timing.jevWallMs);
}

// ---------------------------------------------------------------------------------------
// contract 1.9 (Fastlane) §3 (F25) — the S2 generation path on the `jev-on` propose call
// ---------------------------------------------------------------------------------------

/**
 * §3.1: how many TTFB readings a run keeps. The p50 is a running statistic, not a series: past a few hundred
 * readings another one cannot move it, and an unbounded array on a 40-step run with a hedge per step is memory
 * spent on nothing. The per-step copy takes the same bound so a pathological step cannot grow `steps.jsonl`.
 */
export const TTFB_READINGS_MAX = 256;

/**
 * §3.2: one leg of a hedged one-shot propose call, as `Engine.generate` sees it. `sample` is set ONLY on the
 * twin (`HEDGE_TWIN_OFFSET`), so an unhedged call's events and `generator.jsonl` row are byte-identical to HEAD's.
 */
interface OneShotLeg {
  signal: AbortSignal;
  onFirstByte: (ms: number) => void;
  sample?: number;
}

/**
 * §3.2: what the twin sends — the origin's request with its upstream order ROTATED, so the provider that is
 * currently silent is the twin's last choice instead of its first. A request without a `providerPrefs.order`
 * (which is every request the loop sends today) is returned unchanged, and the twin is then a pure latency race.
 */
function twinRequest(req: GenerateRequest): GenerateRequest {
  const order = req.providerPrefs?.order ?? [];
  if (order.length < 2) return req;
  return { ...req, providerPrefs: { requireParameters: req.providerPrefs?.requireParameters ?? true, order: [...providerOrderFor(order, true)] } };
}

/**
 * The `generator.jsonl` prompt hash. An agent turn sends `messages: []` and its transcript in `agent.messages`
 * (docs/AGENT-LOOP-DESIGN.md §6.1), so the transcript joins the hash — otherwise every turn of a run would share one. A legacy
 * request has no `agent` member and hashes exactly as it always did.
 */
function promptHashOfRequest(req: GenerateRequest): string {
  return sha12(toJson(req.agent === undefined ? { system: req.system, messages: req.messages } : { system: req.system, messages: req.messages, agent: req.agent.messages }));
}

/** docs/AGENT-LOOP-DESIGN.md §15 S4 item 7: an agent transcript's characters, for the unfinished-call estimate; 0 for a legacy request. */
function agentMessageChars(req: GenerateRequest): number {
  if (req.agent === undefined) return 0;
  let n = 0;
  for (const m of req.agent.messages) {
    for (const b of m.content) n += b.type === 'text' ? b.text.length : b.type === 'tool_result' ? b.content.length : b.name.length + JSON.stringify(b.input).length;
  }
  return n;
}

/** §3.1–§3.4: did the engine measure anything about this step's own propose call? Only then is `verify` written. */
function s2Measured(draft: Pick<StepDraft, 'verify'>): boolean {
  const s2 = draft.verify.s2;
  return s2.ttfbMs.length > 0 || s2.hedges > 0 || s2.cacheRead > 0 || s2.cacheWrite > 0;
}

function zeroTiming(): StepTiming {
  return { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 };
}

/**
 * F13 (finishing pass): the OPTIONAL `StepTiming` buckets that are summed onto the run.
 *
 * `imagesMs`, `synthMs`, `decomposeMs` and `jevWallMs` were summed; `coordinateMs`, `coordWaitMs` (contract 1.4
 * W2b, COORDINATION-DESIGN §4.2) and `fastPathMs` / `fastPathJevMs` (contract 1.9 Fastlane §4.4, §5.2) were
 * written per step and summed nowhere, so `state.json`'s run timing block silently disagreed with the sum of
 * `steps.jsonl` and an archived run could not be read for its coordinate or fast-path wall at all.
 *
 * `routerWaitMs` is deliberately NOT here: contract 1.9 §0.4 I3 asserts it per ROUTED SITE (it reads 0 on every
 * path that is not a bug) and the bench-wide row is still open (docs/LLM-LOOP-DESIGN.md §7.5, recorded gaps), so
 * a run-level sum would be a figure no design names.
 */
export const RUN_TIMING_BUCKETS = ['imagesMs', 'synthMs', 'decomposeMs', 'coordinateMs', 'coordWaitMs', 'fastPathMs', 'fastPathJevMs', 'jevWallMs'] as const;

/**
 * F13 / review defect **A10**: the optional `StepTiming` buckets a step reached, as ONE list.
 *
 * They used to be spread inline at two places — the commit path's `StepTiming` literal and `llmJevTiming` — and
 * the two lists had already drifted: `llmJevTiming` omitted `fastPathMs` / `fastPathJevMs`, so in `llm-jev` a
 * COMMITTED step could never sum them onto the run while `absorbDiscardedTiming` reads `draft.fastPathMs`
 * directly for both branches and would. Unreachable today only because `resolveFastPathOption` forces `'off'`
 * outside `jev-on` — which is an accident of a switch, not a property. An inline list at two sites is exactly
 * how four buckets went unsummed in the first place, so there is one builder and `RUN_TIMING_BUCKETS` is its
 * pair (the test asserts they agree, minus `synthMs`, which only the llm-jev builder writes and writes always).
 *
 * Each member is ABSENT rather than 0 when its gate did not run, which is what keeps a coordination-off /
 * fast-path-off step's row byte-identical to HEAD's (contract 1.9 I2). `imagesMs: 0` is the exception and is
 * deliberate: it is a MEASUREMENT (the image pass ran and cost nothing), so only `null` means "did not run".
 */
export function optionalStepTiming(d: { imagesMs: number | null; decomposeMs: number; coordinateMs: number; coordWaitMs: number; jevWallMs: number; fastPathMs: number; fastPathJevMs: number }): Partial<StepTiming> {
  return {
    // TUI-DESIGN §12.3 / §15 item 3: image time is already inside harnessMs and is reported separately for perf/step-overhead.ts
    ...(d.imagesMs !== null ? { imagesMs: d.imagesMs } : {}),
    // contract 1.5 (§4.1 [D13]): likewise inside harnessMs, absent when the gate was shut — M2 reads its p95
    ...(d.decomposeMs > 0 ? { decomposeMs: d.decomposeMs } : {}),
    // contract 1.4 (W2b) (§4.2): the coordinate gate, absent when it did not run (no ledger, or a read/done action)
    ...(d.coordinateMs > 0 ? { coordinateMs: d.coordinateMs } : {}),
    ...(d.coordWaitMs > 0 ? { coordWaitMs: d.coordWaitMs } : {}),
    // contract 1.9 (Fastlane) §5.2 (slot C): the round's own wall and the Jev latency inside it; absent when no round ran
    ...(d.fastPathMs > 0 ? { fastPathMs: d.fastPathMs } : {}),
    ...(d.fastPathJevMs > 0 ? { fastPathJevMs: d.fastPathJevMs } : {}),
    // OOS iteration 2, defect 3: the wall measured inside `decider.ask`, the number `jevChargedMs` charges
    // `harnessMs` by when the decider under-reports (every mock, stub and `--jev off` double). Absent when
    // nothing was asked.
    ...(d.jevWallMs > 0 ? { jevWallMs: d.jevWallMs } : {}),
  };
}

/** The `StepDraft` members `optionalStepTiming` reads — two of them live beside `draft.timing`, not inside it. */
function optionalTimingInput(draft: StepDraft): Parameters<typeof optionalStepTiming>[0] {
  return {
    imagesMs: draft.timing.imagesMs,
    decomposeMs: draft.timing.decomposeMs,
    coordinateMs: draft.timing.coordinateMs,
    coordWaitMs: draft.timing.coordWaitMs,
    jevWallMs: draft.timing.jevWallMs,
    fastPathMs: draft.fastPathMs,
    fastPathJevMs: draft.fastPathJevMs,
  };
}

/**
 * Fold one committed step's timing into the run's. The five required members add; each optional bucket adds only
 * where the step carried it, so a bucket no step of the run wrote stays ABSENT on the run — which is what keeps a
 * coordination-off / fast-path-off run's `state.json` byte-identical (contract 1.9 I2,
 * test/unit/loop/engine-coordination-off.test.ts).
 *
 * **What `RunResult.timing` is, exactly** (review defect A9). It is the sum of the COMMITTED steps — the
 * `steps.jsonl` rows — **plus the wall of any attempt §9.1 rule 1 discarded**. A discarded attempt writes no
 * `StepRecord` (a blocking pause landed before any action ran and the step NUMBER is replayed with a fresh
 * draft), but it really spent that wall and that money, so `absorbDiscardedTiming` adds its buckets to the run
 * directly. That was already true of `decomposeMs` and `generatorMs` before this wave; F13 made it true of four
 * more. So a reader reconciling `state.json` against `steps.jsonl` on a run with a blocking pause will find the
 * run LARGER, by exactly the discarded attempt's share, and that is the contract — not a leak.
 */
export function addStepTimingToRun(run: StepTiming, step: StepTiming): void {
  run.generatorMs += step.generatorMs;
  run.jevMs += step.jevMs;
  run.execMs += step.execMs;
  run.harnessMs += step.harnessMs;
  run.totalMs += step.totalMs;
  for (const k of RUN_TIMING_BUCKETS) {
    const v = step[k];
    if (v !== undefined) run[k] = (run[k] ?? 0) + v;
  }
}
function zeroCounters(): RunCounters {
  return { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 };
}

const ACTION_ERROR_CODES: readonly string[] = ['edit', 'patch', 'path_escape', 'secret_path', 'not_found'];

function redactDeep(v: unknown, redact: Redact): unknown {
  if (typeof v === 'string') return redact(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact));
  if (v instanceof Map || v instanceof Set) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x, redact);
  return out;
}

/**
 * jev-on and jev-only consume Jev answers (intent, context, risk, judge, replan); jev-off is the generator alone (§13).
 * llm-jev is true here too (docs/LLM-JEV-DESIGN.md §6.3) while every intent/context/judge branch it guards is edited to
 * skip or compute in that mode: replan on a trip, harm-only risk, code judge, code completion.
 * `agent` is false (docs/AGENT-LOOP-DESIGN.md §2.2): the driver proposes and no intent, context, risk, judge or replan stage runs.
 */
export function usesJev(mode: EngineMode): boolean {
  return mode !== 'jev-off' && mode !== 'agent';
}

/**
 * docs/LLM-JEV-DESIGN.md §3 row 2 / §9.3 (llm-jev): the step intent is a code fact of the proposal kind — no Jev Choice is
 * asked, and the verdict `'code'` tells the TUI intent line so (a Jev-resolved intent is chosen / overridden / fallback).
 */
export function codeIntent(kind: Action['kind']): IntentStageResult {
  const intent: Intent = kind === 'run' ? 'verify' : kind === 'done' ? 'finish' : kind === 'read' ? 'investigate' : 'edit';
  return { intent, answer: intent, verdict: 'code', probability: 1, confidence: 1, pairedNoul: 1, planStillValid: 1 };
}

/** §4.8: the generator.jsonl `stopReason` of an aborted sample — its deadline ('timeout') or a cancellation (loser, engine stop). */
function abortStopReason(reason: unknown): 'timeout' | 'cancelled' {
  const timeout = reason instanceof Error && (reason.name === 'TimeoutError' || /\b(timeout|timed out|deadline)\b/i.test(reason.message));
  return timeout ? 'timeout' : 'cancelled';
}

/** TUI-DESIGN §8.7 / §15 item 1: `token_cap` joins the plain budget set; `human_pause` never does (a /resume proceeds without --force). */
function isPlainStopBudget(reason: StopReason): reason is 'spend_cap' | 'token_cap' | 'max_steps' | 'wall_time' | 'max_replans' {
  return reason === 'spend_cap' || reason === 'token_cap' || reason === 'max_steps' || reason === 'wall_time' || reason === 'max_replans';
}

/** TUI-DESIGN §12.3: only workspace-changing actions take images; `read` and `done` change nothing. */
function imageSourceOf(action: Action): ImageSource | null {
  switch (action.kind) {
    case 'edit':
    case 'write':
    case 'patch':
    case 'run':
      return action.kind;
    default:
      return null;
  }
}

/** TUI-DESIGN §15 item 3: the committed plan after a step, each list ≤ 20 × 200 chars, for /rewind. */
export function planSnapshot(plan: Plan): PlanSnapshot {
  const item = (t: string): string => clip(t, PLAN_SNAPSHOT_CHARS);
  return {
    done: plan.done.slice(-PLAN_SNAPSHOT_ITEMS).map((d) => ({ text: item(d.text), evidence: { ...d.evidence } })),
    remaining: plan.remaining.slice(0, PLAN_SNAPSHOT_ITEMS).map(item),
    unverified: plan.unverified.slice(-PLAN_SNAPSHOT_ITEMS).map((u) => ({ ...u, text: item(u.text) })),
    harnessProblems: plan.harnessProblems.slice(-PLAN_SNAPSHOT_ITEMS).map((h) => ({ ...h, text: item(h.text) })),
  };
}

/** TUI-DESIGN §12.1 / §12.2: what run.json and the `workspace` event keep of a probe — plus ahead/behind and unmerged for the banner (wave 2 fields). */
export function runGitMetaOf(g: GitState): RunGitMeta {
  return { ...toRunGitMeta(g), ahead: g.ahead, behind: g.behind, dirtyAtStart: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked, unmerged: g.dirty.unmerged } };
}

/** TUI-DESIGN §15 item 4: an HTTP-side error keeps its status, side and request id on the wire. */
function serializeStopError(e: unknown, redact: Redact): SerializedError {
  const base = serializeError(e, redact);
  if (e instanceof JevHttpError) return { ...base, status: e.status, retryable: e.retryable, side: 'jev', requestId: e.requestId };
  if (e instanceof ProviderHttpError) return { ...base, status: e.status, retryable: e.retryable, side: 'generator', requestId: e.requestId };
  return base;
}

/**
 * TUI-DESIGN §8.6: `clip(…, max)` for human text — `clip` cuts by UTF-16 index, so a surrogate pair straddling the bound
 * would leave a lone high surrogate before the marker (an ill-formed string in every artefact and on the wire).
 */
function clipText(s: string, max: number): string {
  const c = clip(s, max);
  if (c === s) return c;
  const body = c.slice(0, -1);
  const last = body.charCodeAt(body.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? `${body.slice(0, -1)}…` : c;
}

/** docs/AGENT-LOOP-DESIGN.md §5.1: an optional prompt section's text, or null when it is absent or blank. */
function nonEmptyText(s: string | undefined): string | null {
  const t = s?.trim() ?? '';
  return t.length > 0 ? t : null;
}

/** TUI-DESIGN §12.3: the HEAD oid a post image records (null: unborn or no repository). */
function headOidOf(g: GitState | null): string | null {
  const head = g?.head ?? null;
  if (head === null || head.kind === 'unborn') return null;
  return head.oid;
}

/** TUI-DESIGN §8.5: the lock is taken after store.create / the resume load; a live foreign lock is a ConfigError (exit 2), anything else only a warning. */
function takeRunLock(runDir: string, runId: string): { held: boolean; warning: string | null } {
  let warning: string | null = null;
  try {
    acquireRunLock(runDir, { runId, pid: process.pid, host: hostname(), nowIso: nowIso(), warn: (m) => (warning = m) });
    return { held: true, warning };
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    return { held: false, warning: `run.lock could not be written: ${e instanceof Error ? e.message : String(e)}` };
  }
}

class EngineImpl implements Engine {
  readonly runId: string;
  readonly events: EngineEmitter;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly opts: EngineOptions;
  /**
   * OOS 2026-09-22 ranked change 2: the run's `requestHash` -> answer cache. 454 of the slice's
   * 2,330 requests (19.5 %) re-issued a hash already answered in the SAME run (339/1,532 ladder,
   * 115/744 SWE, 0 QuixBugs). Lifetime is one RUN and nothing wider: the Engine is built per run
   * and `run()` is single-shot, and `run()` clears it anyway so a reopened engine starts empty.
   * A hit is recorded in jev.jsonl exactly like a call, with `usage.calls: 0`, `costUsd: 0` and
   * `latencyMs: 0` — so the meter cannot bill it and the hits are countable off the records.
   */
  private readonly jevCache: CachingDecider;
  private readonly mode: EngineMode;
  private readonly redact: Redact;
  private readonly store: CheckpointStore;
  private readonly workspace: Workspace;
  private readonly sandbox: Sandbox;
  private readonly wsInfo: WorkspaceInfo;
  private readonly clock: () => number;
  /**
   * contract 1.4 (W2b), COORDINATION-DESIGN §4.1: the coordination ledger's engine side, or `null` — no handle, or
   * `enabled: false`, or a bench task. Every call site reads `this.coord?.x()`, so OFF is the absence of an object
   * rather than a flag twenty branches have to honour (`engine-coordination-off.test.ts` is the proof).
   */
  private readonly coord: CoordinationRuntime | null;
  /** contract 1.4 (W3), §6 / W3 item 28: `SynthesisContext.coordination`, built once per run by `synthSubwork()` */
  private subworkAdapter: SynthSubwork | null = null;
  /** contract 1.4 (W0 item 1), §3.2 / §9.3: `RunMeta.claims[]` as this process knows it — the resumed rows plus every mint it made */
  private localClaims: RunClaimRow[] = [];
  /** contract 1.4 (W0 item 1), §3.2 / §9.3: `RunMeta.claimEpochHigh` — the monotonic high-water mark, resumed and then raised at each mint */
  private claimEpochHigh = 0;
  /**
   * §12.0.1 rule 5: `setIdentity({ repoKey, runId })` after `run:ready`; its promise resolves once every newly
   * reachable watch root has been walked ONCE. Awaited before the FIRST `coordinate` and never again — `fs.watch`
   * reports future changes only, so a check made before the walk could read `clear` by ignorance (§3.5).
   */
  private coordReady: Promise<void> | null = null;
  /**
   * contract 1.4 (W2b), §9.3: a QUALIFIED foreign claim supersedes this process's. Set by `checkFork`, acted on at
   * the loop top — never in the middle of a step, because the whole point is to stop BEFORE a second writer touches
   * the run dir, and the middle of a step is after it already has.
   */
  private forkStop: string | null = null;
  /** contract 1.4 (W2b), §3.3: the union of the last 3 committed steps' post images, for the heartbeat */
  private touchedRecent: string[] = [];
  /** contract 1.4 (W2b), §3.6: the injected resource pre-flight (`EngineDeps.preflightProbe`) */
  private readonly preflightProbe: PreflightProbe;
  private readonly systemPrompt: string;
  /** jev-only propose stage; null in the other modes (createEngine rejects jev-only without one) */
  private readonly synthesizer: Synthesizer | null;
  /** docs/LLM-JEV-DESIGN.md §9.4: the synthesizer's `handles()` verdict for this run, decided at the first propose stage */
  private synthHandles: boolean | null = null;
  private readonly resumed: boolean;
  private readonly resumeStop: StopReason | null;

  // engine state (§11 state-mutation rule: plan/window/detector change only in commit)
  private step = 0;
  // contract 1.5 (ORCHESTRATION-DESIGN §3.1, §4.1): what this run has delegated. `splits` is counted against
  // `orchestrate.maxSplits` and only a WRITTEN manifest consumes a slot (corner row 8); `lastSplitStep` is the
  // `splitEvery` cooldown; `orchestration` is the delegation itself, re-read on resume by corner row 12.
  private splits = 0;
  private lastSplitStep: number | null = null;
  private orchestration: NonNullable<CheckpointState['orchestration']> | null = null;
  /** corner row 12: `agent:adopted` is announced once per process, not once per step */
  private adoptedAnnounced = false;
  private plan: Plan = emptyPlan();
  private window: WindowEntry[] = [];
  // docs/COORDINATION-DESIGN.md §8: the generator's relaxed context — `window` above stays Jev's 4 × 600 (§8.1 two windows)
  private history: HistoryEntry[] = [];
  private fileCache: FileCacheEntry[] = [];
  private fileMemory: FileMemory = {};
  private summary: ContextSummary | null = null;
  private summaryAt: number | null = null;
  /**
   * docs/COORDINATION-DESIGN.md §8.6 fourth bullet (F26): the kept items, re-extracted at every compaction and
   * persisted as `CheckpointState.kept`. Empty until the run's first compaction, which is what keeps a short
   * run's `state.json` byte-identical to the one it wrote before this landed.
   */
  private kept: KeptItem[] = [];
  /** §8.6 `context.kept: 'jev'`: one bounded ordering request is owed for the compaction just made */
  private keptRankPending = false;
  private compactions = 0;
  private lastCompactionAt: string | null = null;
  private contextUsage: ContextUsage;
  private readonly contextPolicy: ResolvedContextPolicy;
  /**
   * §8.8 / review D5: only the modes whose prompt CONSUMES the relaxed view pay for it. `jev-only` never prompts a
   * generator at all, so it still builds nothing — no view, no `outputs/`, no summary, no `status.context`.
   *
   * `llm-jev` joins the generator modes here (TUI-DESIGN-5 §8.2 R13). §8.8's third column landed as
   * `SynthesisContext.contextText`, so the view is no longer dead weight with a meter stuck at 0 %:
   * `synthContextText()` assembles it once per step and the candidate source puts it in every `propose_fix` sample.
   * D5's "until it exists" is the condition that changed; the accounting did not. The cost llm-jev now pays is the
   * generator modes' cost — one `outputs/step-<n>.txt` per step with a non-empty output, under the per-run **64 MiB**
   * output bound that evicts the oldest past it (§8.5 / review D12, `CheckpointStore.writeOutput`), a
   * `context/summary.json` once a compaction runs, and the `history` / `fileCache` / `fileMemory` checkpoint additions.
   */
  private readonly contextEnabled: boolean;
  private readonly filesInView: FilesInView;
  /** head + tail of the newest outputs by step (≤ HISTORY_MID); read back from `outputs/` once after a resume */
  private readonly outputViews = new Map<number, OutputView>();
  /** steps whose `outputRef` this device cannot follow (§8.5: the prompt says so instead of pointing at nothing) */
  private readonly missingOutputs = new Set<number>();
  private contextLoaded = false;
  /** the post image of the step in flight, consumed by commitContext (§8.4 fileMemory from the hashes already computed) */
  private lastPostImage: PostImage | null = null;
  /** §8.2 / review D8: `windowTooSmall`, announced once after run:ready (the constructor has no listeners yet) */
  private pendingWindowNotice: string | null = null;
  /** §8.6 / review D20: a resume that folded rows past the history window compacts once, before the first prompt */
  private pendingResumeCompaction = false;
  /** §8.2(c) / §8.9: what the last prompt build cost and what the tier ladder did — carried on `ContextUsage` */
  private lastRecentSteps: RecentStepsUsage = { chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 };
  private lastRefreshMs = 0;
  private lastPromptBuildMs = 0;
  /** contract 1.6 (IMPORT-DESIGN §2.10.3): the two memory sections of the last build, and the run's index size */
  private lastMemoryBuild: PromptMemoryBuild | null = null;
  private readonly memoryIndexChars: number;

  private readonly detector: LoopDetector;
  private wallMsUsedBefore = 0;
  private runStartMono: number | null = null;
  private timing: StepTiming = zeroTiming();
  private jevLatencyMs: number[] = [];
  /** combined per committed step; always generatorTokensPerStep[i] + jevTokensPerStep[i] */
  private tokensPerStep: number[] = [];
  private generatorTokensPerStep: number[] = [];
  private jevTokensPerStep: number[] = [];
  private counters: RunCounters = zeroCounters();
  private directive: ReplanDirective | null = null;
  private lastTestRun: CheckpointState['lastTestRun'] = null;
  private lastChangeStep: number | null = null;
  private readonly createdThisRun = new Set<string>();
  private resolvedJevModel: string | null = null;
  private jevModelDrift: { step: number; served: string } | null = null;
  /** TUI-DESIGN-2 §2.5: the checkpoint's resolved id was re-keyed to the new provider's naming on this cross-provider resume (persisted in run()) */
  private resolvedRekeyed = false;
  /** TUI-DESIGN-2 §2.4: how the Jev requests of THIS process were priced (`costBlock` / `/jev` suffix); jev.jsonl holds the per-request truth */
  private readonly jevBasisCounts = { table: 0, provider: 0 };
  private stopReason: StopReason | null = null;
  private stateError: { stage: StageName; code: string } | undefined;
  private interrupted: CheckpointState['interrupted'] = null;
  private consecutiveStageFailures = 0;
  /**
   * AGENT-LOOP-DESIGN §A1 "works perfectly": the agent's model turn failed with a provider error that the same request would
   * hit again (a 4xx: a wrong model id, a rejected key or request), or with a transient one before the run's first committed
   * step — the run stops at this step with `error`, not after a three-failure streak (the chat's one retry is the session's)
   */
  private agentProviderStop = false;
  /** opaque jev-only synthesizer state, persisted with every checkpoint (§JEV-ONLY-DESIGN 5.2) */
  private synthState: Json | null = null;
  /** Σ decisions.length over committed steps (RunResult.jevQuestions); persisted so it survives --resume */
  private jevQuestions = 0;
  private resumes = 0;
  private jevCalls = 0;

  // transient
  private currentStage: StageName | 'idle' = 'idle';
  private draft: StepDraft | null = null;
  private pendingCheckpoint: Promise<void> | null = null;
  private pendingPersists = new Set<Promise<void>>();
  private candidateRefresh: Promise<void> | null = null;
  private deadline: WallDeadline | null = null;
  private aborting = false;
  private finished: Promise<RunResult> | null = null;
  private lastResult: RunResult | null = null;
  private lastSnapshot: CheckpointState | null = null;
  private fatalError: unknown = null;
  private lastStageError: unknown = null;
  private lastErrorStage: StageName | null = null;
  private nextHints: PromptHints = {};
  private pendingLoopNotice: string | null = null;
  private firstStepAfterResume = false;
  private exitHandler: (() => void) | null = null;
  private driftWarned = false;
  /** monotonic counter behind transcript.log lines (§10: same numbering as the renderers, from 0) */
  private transcriptSeq = 0;
  /** a refused resume never touches the run dir, transcript.log included */
  private transcriptMuted = false;

  // contract 1.1 (TUI-DESIGN §15.2 "fields"): steering, pause and the widened abort. Consumption of the
  // directives at step start, retry waking and the blocker are wave 2.
  /** steers queued and not yet applied (<= MAX_PENDING_DIRECTIVES); checkpointed, restored on --resume */
  private pendingDirectives: PendingDirective[] = [];
  private steerSeq = 0;
  /** pause() was called: finish('human_pause') at the next loop top (§9.1 rule 1) */
  private pauseRequested = false;
  /** the signal behind abort('signal'), for exit codes 130 / 143 / 129 (§13.5) */
  private signalName: SignalName | null = null;
  /** abort('error', { error }): the fatal error the run ends with (§13.4); preferred over fatalError when set */
  private fatalSerialized: SerializedError | null = null;
  /** run() was called (set before the loop's synchronous prefix emits its first events, unlike `finished`) */
  private started = false;

  // contract 1.1 wave 2 (TUI-DESIGN §15.2 "fields after L370"): directive consumption, retry waking, images, blocking pauses, money events
  /** the directives applied to the step about to run (§8.6); cleared at commit; re-derived from plan.harnessProblems on --resume */
  private activeHuman: { texts: string[]; step: number } | null = null;
  /** one AbortController per retry sleep (§13.2): created by onRetry, aborted by retryNow(), nulled when the chain settles */
  private retryWaker: AbortController | null = null;
  /** docs/LLM-JEV-DESIGN.md §4.8: the retry wakers of the llm-jev samples other than sample 0 (whose waker is `retryWaker`, shown in the status) */
  private readonly sampleWakers = new Map<number, AbortController>();
  private retrying: NonNullable<EngineStatus['retrying']> | null = null;
  /** carried from the seed or EngineOptions.undoLog, checkpointed, never written into a finished run (§15 item 9) */
  private undoLog: UndoLogEntry[] = [];
  /** `[c] continue without checkpoints` was chosen, or a disk-class error hit state.json (§13.3): a later stop exits 3 */
  private checkpointDegraded = false;
  /** `checkpoint degraded: <code> on <file>` keys already noticed (once per (file, code), §13.3) */
  private readonly warned = new Set<string>();
  /** generator input + output tokens over the run; rebuilt from generatorTokensPerStep on --resume (§9.5 token_cap) */
  private generatorTokens = 0;
  private seeded = false;
  /** the blocking pause awaiting an answer at the loop top (§13.3); set by the failing stage after the rule-1 discard */
  private blocked: BlockingRequest | null = null;
  private blockedError: unknown = null;
  /** a block a stage decided mid-call (first-call drift) before its throw reaches handleStepError */
  private stageBlock: { request: BlockSpec; error: unknown } | null = null;
  private blockingSeq = 0;
  /** consecutive `jev-unreachable` pauses: 30 s, 60 s, … 5 min (§13.2) */
  private unreachablePauses = 0;
  /** budget:warn thresholds announced this run, per scope (§9.2: once per (scope, pct) per run) */
  private announcedRun: ReadonlySet<BudgetPct> = new Set<BudgetPct>();
  private announcedSession: ReadonlySet<BudgetPct>;
  /** the spend restored from the checkpoint on this resume: its crossings are re-announced once with `restored: true` (§9.2) */
  private readonly restoredSpentUsd: number | undefined;
  /** committed per-step cost this process, for the p50 behind `stepsLeftEstimate` (§9.2) */
  private readonly costPerStep: number[] = [];
  /** the output of the engine's last parsed test run, for the `done` state's `lastRun.output` (state.ts ExecutedInfo.lastRunOutput) */
  private lastTestRunOutput: string | null = null;
  /**
   * contract 1.9 (Fastlane) docs/LLM-LOOP-DESIGN.md §4.3 T3: `scopeUsable()` over the last parsed test run. In-memory
   * only and rebuilt by the next run, exactly like `lastTestRunOutput`: a resumed run cannot arm until one happens.
   */
  private lastTestRunScopeUsable = false;
  /**
   * contract 1.9 (Fastlane) §0.3 / §4: the bounded sieve fast path. `'auto'` in `jev-on`, `'off'` everywhere else;
   * `JEVCODE_FASTPATH=off|auto` overrides, read here exactly as `JEVCODE_WARM` is read in `src/jev-modes/synth/warm/plane.ts`
   * (no `src/config` and no `src/cli` change). With `'off'` the runner is never built and the three `if`s below are
   * all false, which is the whole of I2 (byte identity).
   */
  private readonly fastPathOption: 'auto' | 'off';
  /**
   * contract 1.9 (Fastlane) §3 (F25): the S2 generation path's effective mode for this run — `jev-on` only,
   * `JEVCODE_S2=on`, default off. `'partial'` is the measurement half without the §3.2 hedge (`JEVCODE_HEDGE=off`).
   * Every S2 mechanism on the propose path is behind `this.s2 !== 'off'`, so an S2-off run is the pre-1.9 run byte
   * for byte: the legacy prefix order, no TTFB callback, no twin, and no `StepRecord.verify` on a jev-on step.
   */
  private readonly s2: 'on' | 'partial' | 'off';
  /**
   * contract 1.9 (Fastlane) §3.1: every TTFB this run's propose calls observed — the input of the §3.2 threshold,
   * exactly as `ttfbMsAll` is in the synthesizer's source. Bounded: a long run must not accumulate a reading per step.
   */
  private readonly ttfbMsAll: number[] = [];
  private fastPathRunner: FastPathRunner | null = null;
  /** T2, cached once per run: does the fast path's own synthesizer cover this workspace (`synthesizerHandles`)? */
  private fastPathHandles: boolean | null = null;
  /** a provider reported usage without a finite cost (§9.5): the run stops with error after the step commits unless --allow-unpriced */
  private unpriced: { side: SpendSource; model: string; stage: StageName } | null = null;
  /** `budget:unpriced` is one item per (side, model) per run (§9.5), not one per metered call */
  private readonly unpricedAnnounced = new Set<string>();
  /** finish() is in flight (the final snapshot is built): steer/unsteer/pause/annotate read as finished so nothing is confirmed and then dropped (§8.6) */
  private finishing = false;
  /** the run-start probe (§12.1); null when the probe was unavailable */
  private gitState: GitState | null;
  private readonly gitMeta: RunGitMeta;
  /** §A1: the background re-probe still to adopt (a run started from a cached probe); null once adopted or when there is none */
  private gitRefresh: Promise<GitState | null> | null = null;
  /**
   * paths dirty at run start (top-level relative, prefix stripped): a changed file outside it was clean at start (§12.3 cleanAtStart);
   * refilled in place when a run that started from a cached probe adopts the fresh one (AGENT-LOOP-DESIGN §A1)
   */
  private readonly dirtyAtStart: Set<string>;
  private readonly runDir: string;
  private lockHeld: boolean;
  /** notices decided before run(): the stale-lock replacement, the HEAD-drift warning; emitted after run:ready so every writer sees them */
  private readonly startupNotices: { kind: 'lock' | 'drift'; level: 'warn'; text: string }[] = [];
  /**
   * TUI-DESIGN §8.6 / §15.2: steer, unsteer, pause and secret-ack items decided before run() (EngineOptions.humanDirective
   * included) are announced after run:ready in the order they happened, so every writer sees run:start first.
   */
  private deferredAnnouncements: EngineEvent[] = [];

  // contract 1.4 (COORDINATION-DESIGN §7.2–§7.4, §12.0.2): pause points
  /** pause({ at: 'now' }) was requested (§7.2); an execute in flight finishes first (P4) */
  private pauseNow = false;
  /** who asked for the pause (§5.3 `by`); 'self' unless a remote message (deliver) said otherwise */
  private pauseBy: PausePoint['by'] = 'self';
  /** end() was requested: RunMeta.ended rides the final human_pause write (§7.4) */
  private endRequested: { by: 'human' | 'remote' } | null = null;
  /** the point as decided where the run stopped (loop top, rule-1 discard, pane answer); finish() completes and emits it */
  private pauseAt: PendingPausePoint | null = null;
  /** a pause-now landed while execute ran (P4) or cut the judge (P5): the boundary point reads 'now-after-execute' */
  private pauseLandedInExecute = false;
  /** the last PausePoint of this process (EngineStatus.pausePoint); null until the point is reached */
  private pausePoint: PausePoint | null = null;
  /**
   * the cache/step-<n>.json write a pause-now enqueued, together with WHAT IT WROTE (§12.0.2: `replayable` and the point's
   * round are facts of the file, not of the draft the discard reads a tick later — a sample or a proposal landing between
   * the snapshot and the discard must not promise a replay the file cannot serve). `done` is awaited (bounded) by finish().
   */
  private pauseCache: {
    step: number;
    rel: `cache/step-${number}.json`;
    /** the resumes counter of the process entitled to replay it (this run's + 1) */
    resumes: number;
    at: string;
    hadProposal: boolean;
    arrivedCount: number;
    partialChars: number;
    round: number | null;
    llm: { goalId: string; round: number; arrived: number[] } | null;
    done: Promise<{ ok: boolean; targetsSha: Record<string, string | null> }>;
  } | null = null;
  /** abort() after a pause-now: the later abort wins the classification and the exit code (§7.2, §11 row 38) */
  private abortOverride: AbortError | null = null;
  /** created per awaitBlocker; pause() aborts it so an awaited pane resolves { answer: 'pause' } (P6) */
  private blockWaker: AbortController | null = null;
  /** §7.2 / §12.0.4: the replay detail beside `interrupted`; cleared with it at commit */
  private interruptedDetail: InterruptedDetail | null = null;
  /** §12.0.3 / D7: chars of the last generator prompt built this run (CheckpointState.lastPromptChars), persisted at commit */
  private lastPromptChars: number | null = null;
  /** §7.3 step 3: the cache the next runStep() replays (EngineOptions.resume.replay, gated by the target hashes at run start) */
  private replayCache: StepCache | null = null;
  private readonly replayRequested: boolean;
  /** a --force resume of an ended run (§7.4): the resumes[] entry records `reopened` and run.json.ended is cleared */
  private readonly reopened: boolean;

  // contract 1.5 (ORCHESTRATION-DESIGN §2.4, §2.5, §2.6, §5.7): the child differences and the launch.
  // Every one is inert on a run without `EngineOptions.orchestration`.
  /** §2.4 / corner row 18: CONSECUTIVE belt-2 refusals; `SCOPE_FIGHT_AFTER` of them park the child */
  private beltRefusals = 0;
  /** §2.4 [G8]: the post-`run` escape diff of the step in flight, moved onto `StepRecord.escaped` at commit */
  private escapedThisStep: readonly string[] = [];
  /** §2.6 [G1]: the sha of the harness commit this step produced, moved onto `StepRecord.commit` at commit */
  private commitThisStep: string | null = null;
  /** §2.6 [D2] `touched`: ⋃ over this run's steps of `ActionOutcome.changedFiles` — file actions AND post-`run` diffs */
  private readonly touchedPaths = new Set<string>();
  /** §2.6: the sha of the unconditional `run:end` commit (`RunResult.commit`) */
  private endCommit: string | null = null;
  /** §2.5(c) / P10: a parked review is pending, so the rule-1 discard's point reads `review-needed`, not `now` */
  private reviewParked = false;
  /** §2.5(c) / corner row 29: the answer file was consumed this run — single-use, whatever a replay does */
  private reviewAnswerUsed = false;
  /** §5.7: the proposal the harness seeded for the NEXT step (the launch merge, or the [c] / [s] pre-flight step) */
  private seededStep: { step: number; proposal: Proposal; note: string } | null = null;
  /** §5.7: what `/land` is landing, so the merge's `executed` outcome can write `RunMeta.landed` */
  private pendingLand: { branch: string; agents: number; delegatedAt: number } | null = null;
  /** §5.7 tail: `RunMeta.landed`, newest last */
  private landedMerges: readonly { step: number; branch: string; commit: string }[] = [];

  // docs/AGENT-LOOP-DESIGN.md §2.2, §7.5, §8, §10 (slice S4): the agent seam. Every member is inert outside `agent` mode — the
  // driver is never loaded, the state stays null (so `state.json` carries no `agentState`) and nothing below is read.
  /** the run's driver: `EngineOptions.agent` (tests), else `createAgentDriver()` from `src/agent/index.ts`, loaded once in main() */
  private agentDriverInstance: AgentDriver | null = null;
  /** §10: the driver's opaque `AgentStateV1`, persisted as `CheckpointState.agentState` (≤ AGENT_STATE_MAX_BYTES) */
  private agentState: Json | null = null;
  private agentStateOversizeWarned = false;
  /** §7.4 / §9: `/compact` asked for a compaction before the next turn (`AgentContext.takeCompactRequest`) */
  private agentCompactRequested = false;
  /** §10 Steer: the `activeHuman` object the driver already took — a steer is handed over once, never once per attempt */
  private agentSteersTaken: { texts: string[]; step: number } | null = null;
  /** §7.5: the driver's meter, on `EngineStatus.context` in agent mode */
  private agentContextUsage: ContextUsage | null = null;
  /** §8: gate refusals in this process; AGENT_MAX_BLOCKS of them pause the run (a resume starts a fresh allowance) */
  private agentBlocks = 0;
  /** §7.2: the spilled output parts' byte ledger (the store's bound covers `step-<n>.txt` only), and whether its bound was announced */
  private readonly outputParts = createOutputPartLedger();
  private outputPartsFullNoted = false;
  /** §A1: the agent summaries of the steps committed in this process — `isReplyOnlyRun` reads them (a resumed run starts with a non-reply marker) */
  private readonly agentSteps: Pick<StepRecord, 'agent'>[] = [];

  constructor(init: {
    runId: string;
    opts: EngineOptions;
    store: CheckpointStore;
    workspace: Workspace;
    sandbox: Sandbox;
    wsInfo: WorkspaceInfo;
    resume: ResumeLoad | null;
    gitState: GitState | null;
    /** §A1: the background re-probe of a run that started from the caller's cached probe (null: the probe above is fresh) */
    gitRefresh?: Promise<GitState | null> | null;
    runDir: string;
    lock: { held: boolean; warning: string | null };
    headDrift: string | null;
    /** contract 1.4 (§7.4): the resume reopens an ended run under --force */
    reopened?: boolean;
    /** contract 1.4 (W2b), §3.6: the resource pre-flight seam (`EngineDeps.preflightProbe`), resolved by createEngine */
    preflightProbe?: PreflightProbe;
  }) {
    this.runId = init.runId;
    this.preflightProbe = init.preflightProbe ?? nodePreflightProbe();
    this.reopened = init.reopened === true;
    this.replayRequested = init.resume !== null && init.opts.resume?.replay === true;
    this.opts = init.opts;
    this.jevCache = createCachingDecider(init.opts.decider);
    this.mode = init.opts.mode;
    this.redact = init.opts.redact;
    this.store = init.store;
    // contract 1.7 item 8 (TUI-DESIGN-4 §7.2 P-D2 item 1): the store reports every write path's own classification here.
    // Registration happens AFTER the store is final (a resume replaces it with `loadForResume`'s), which is why this is a
    // post-construction listener rather than a `createCheckpointStore` option: `CheckpointStoreFactory` is
    // `(runsDir, runId, redact)` and never sees one. Detached in `finish()`, so a late write cannot emit into a dead engine.
    attachDegradeListener(this.store, (info) => {
      this.noteDisk(info, this.draft?.step ?? null);
    });
    this.workspace = init.workspace;
    this.sandbox = init.sandbox;
    this.wsInfo = init.wsInfo;
    this.clock = init.opts.now ?? monotonicNow;
    this.signal = this.controller.signal;
    this.events = createEmitter((err, event) => {
      // Listener bugs never propagate into the loop; they are reported through the transcript channel.
      if (event.type !== 'transcript') this.events.emit({ type: 'transcript', step: null, level: 'warn', text: `listener error on ${event.type}: ${err instanceof Error ? this.redact(err.message) : String(err)}` });
    });
    // TUI-DESIGN §15.2 constructor row: AGENTS.md text reaches the generator system prompt only (D6)
    const instructions = init.opts.instructions?.text ?? '';
    // contract 1.6 (IMPORT-DESIGN §2.10.1/§2.10.2): the always-on memory index rides the once-per-run system prompt,
    // after `## Project instructions`; absent → the prompt is byte-identical to what it was before 1.6
    const memoryIndex = init.opts.memory?.index?.trim() ?? '';
    this.systemPrompt = buildSystemPrompt({
      mode: this.mode,
      sandboxLevel: init.sandbox.level,
      toolName: 'propose_action',
      ...(instructions.length > 0 ? { instructions } : {}),
      ...(memoryIndex.length > 0 ? { memoryIndex } : {}),
    });
    this.memoryIndexChars = memoryIndexChars(memoryIndex);
    this.synthesizer = init.opts.synthesizer ?? null;
    // contract 1.9 (Fastlane) §0.3: the engine derives the default from the mode; the env override is the bench's switch
    this.fastPathOption = resolveFastPathOption(this.mode, init.opts.fastPath);
    // §3 / §0.3: read once, at construction, like every other mechanism switch
    this.s2 = s2Mode(this.mode, init.opts.s2);
    this.resumed = init.resume !== null;
    // contract 1.4 (W0 item 1, §9.3): the epochs THIS device has already minted or accepted for the run, as the
    // resumed `run.json` recorded them. The resume gate's local set starts here rather than at this process's own
    // claim, which is what stops an epoch GC'd out of the fold from being re-minted.
    this.localClaims = [...(init.resume?.meta.claims ?? [])];
    this.claimEpochHigh = init.resume?.meta.claimEpochHigh ?? 0;
    this.resumeStop = null;
    this.gitState = init.gitState;
    this.gitRefresh = init.gitRefresh ?? null;
    this.gitMeta = runGitMetaOf(init.gitState ?? notRepoState('git-missing', { probedAt: nowIso(), probeMs: 0 }));
    this.dirtyAtStart = new Set(dirtyPathsOf(init.gitState));
    this.runDir = init.runDir;
    this.lockHeld = init.lock.held;
    if (init.lock.warning !== null) this.startupNotices.push({ kind: 'lock', level: 'warn', text: init.lock.warning });
    if (init.headDrift !== null) this.startupNotices.push({ kind: 'drift', level: 'warn', text: init.headDrift });
    let restoredSpentUsd: number | undefined;
    if (init.resume) {
      const s = init.resume.state;
      this.step = s.step;
      this.plan = s.plan;
      this.window = s.window;
      this.detector = createLoopDetector(s.loopDetector);
      this.wallMsUsedBefore = s.wallMsUsed;
      this.timing = { ...s.timing };
      this.jevLatencyMs = [...s.jevLatencyMs];
      this.tokensPerStep = [...s.tokensPerStep];
      // older checkpoints carry only the combined series: the split reads as zeros
      this.generatorTokensPerStep = tokenSeriesOrZeros(s.generatorTokensPerStep, s.tokensPerStep.length);
      this.jevTokensPerStep = tokenSeriesOrZeros(s.jevTokensPerStep, s.tokensPerStep.length);
      this.counters = { ...s.counters };
      this.directive = s.directive;
      this.lastTestRun = s.lastTestRun;
      this.lastChangeStep = s.lastChangeStep;
      for (const p of s.createdThisRun) this.createdThisRun.add(p);
      this.resolvedJevModel = s.resolvedJevModel;
      this.jevModelDrift = s.jevModelDrift;
      // TUI-DESIGN-2 §2.5: a cross-provider resume (reconcileResumeConfig's `decider.provider` override) carries the run's resolved id in
      // the OLD naming (`typesafe/jev-1.13-20260917`); it is re-keyed to the id the new provider serves (`jev-1.13.0`, EQUIVALENT_IDS) so
      // the first call of the resumed run is not read as drift. The override's `to` names the target (it is set even when the caller
      // built `deciderModel` without `provider`); run() persists the re-keyed id with this resume's resumes[] entry.
      const providerSwap = (init.opts.resumeOverrides ?? []).find((o) => o.setting === 'decider.provider');
      if (providerSwap !== undefined && this.resolvedJevModel !== null) {
        const target = providerSwap.to === 'typesafe' || providerSwap.to === 'openrouter' ? providerSwap.to : (init.opts.deciderModel.provider ?? 'openrouter');
        const rekeyed = equivalentJevModel(this.resolvedJevModel, target);
        if (rekeyed !== null) {
          this.resolvedJevModel = rekeyed;
          this.resolvedRekeyed = true;
        }
      }
      this.consecutiveStageFailures = s.consecutiveStageFailures;
      this.jevQuestions = s.jevQuestions ?? 0;
      // contract 1.5 (ORCHESTRATION-DESIGN corner row 12): a resumed run re-finds the delegation it already made, so
      // the gate stays shut and no second manifest is proposed for the same work. `maybeDecompose` re-reads the
      // manifest and compares `manifestId` + `baseSha` before it ADOPTS it.
      this.orchestration = s.orchestration !== undefined ? { ...s.orchestration, agents: s.orchestration.agents.map((a) => ({ ...a })) } : null;
      this.splits = s.splits ?? 0;
      this.lastSplitStep = s.orchestration?.step ?? null;
      this.synthState = s.synthState ?? null;
      if (this.mode === 'agent') {
        // docs/AGENT-LOOP-DESIGN.md §10: the driver's state, its transcript seq raised to the folded rows' `agent.seqAfter` (a prepared
        // loader already did — the raise is a max, so doing it again for the injected-store path is harmless); §3.6 / §8: a resume
        // resets the nudge count, because the human has looked at the run; §A1: the steps before this process are not replies
        this.agentState = s.agentState === undefined ? null : raiseAgentTranscriptSeq(s.agentState, init.resume.foldedSteps.filter((r) => r.step > s.step));
        if (this.counters.loopNudges !== undefined) this.counters.loopNudges = 0;
        if (s.step > 0 || init.resume.foldedSteps.length > 0) this.agentSteps.push({});
      }
      this.resumes = s.resumes;
      this.lastPromptChars = s.lastPromptChars ?? null;
      this.jevCalls = s.jevLatencyMs.length;
      this.interrupted = s.interrupted;
      // contract 1.4 (§7.3 step 4): the replay detail is restored only while `interrupted` names its step; `pausePoint` is never restored (it is this process's)
      this.interruptedDetail = s.interrupted !== null && s.interruptedDetail !== undefined ? { ...s.interruptedDetail, targetsSha: { ...s.interruptedDetail.targetsSha } } : null;
      // contract 1.1 (TUI-DESIGN §15.2): steers queued before the stop are consumed by the resumed run
      this.pendingDirectives = (s.pendingDirectives ?? []).map((d) => ({ ...d }));
      this.steerSeq = this.pendingDirectives.reduce((m, d) => Math.max(m, d.index + 1), 0);
      // TUI-DESIGN §15.2 constructor (resume) row: undoLog merged with the /undo entries of this resume, token counter rebuilt.
      // `checkpointDegraded` is NOT inherited (deviation from the §15.2 row, see §13.3): the state just loaded proves the
      // checkpoint chain is intact, and the exit-3 rule describes failures observed by the process that stops — inheriting
      // the flag made every stop of a healthy resumed run exit 3 with `resumable: false`.
      this.undoLog = [...(s.undoLog ?? []), ...(init.opts.undoLog ?? [])].slice(-UNDO_LOG_MAX);
      this.checkpointDegraded = false;
      this.generatorTokens = this.generatorTokensPerStep.reduce((n, t) => n + t, 0);
      restoredSpentUsd = s.spend.totalUsd;
      for (const rec of [...init.resume.foldedSteps].sort((a, b) => a.step - b.step)) {
        if (rec.step <= this.step) continue;
        this.window = foldStepRecord(this.window, rec);
        this.step = rec.step;
      }
      // TUI-DESIGN §8.6: activeHuman is re-derived from the plan, not stored — a rule-1 discard or crash followed by a resume re-arms the hint
      const humanTexts = this.plan.harnessProblems.filter((h) => h.kind === 'human' && h.step === this.step + 1).map((h) => h.text);
      if (humanTexts.length > 0) this.activeHuman = { texts: humanTexts, step: this.step + 1 };
      this.opts.meter.restore(s.spend);
      // A prepared loader (checkpoint/resume.ts) has already cleared stopReason and bumped resumes.
      const previousStop = init.resume.previousStopReason !== undefined ? init.resume.previousStopReason : s.stopReason;
      this.stopReason = previousStop;
      this.resumeStop = this.storedStopBlocks(s, previousStop);
      if (this.resumeStop !== null) this.transcriptMuted = true;
      if (this.resumeStop === null) {
        if (!init.resume.prepared) this.resumes += 1;
        this.firstStepAfterResume = true;
      }
    } else {
      this.detector = createLoopDetector();
      const seed = init.opts.seed;
      if (seed) {
        // TUI-DESIGN §8.3 / §15.2 constructor (fresh) row: plan/window/createdThisRun/lastTestRun/undoLog from the seed; spend, wall,
        // the loop detector and resolvedJevModel start fresh; lastChangeStep null so testsCurrent is recomputed honestly
        this.plan = { done: seed.plan.done.map((d) => ({ ...d, evidence: { ...d.evidence } })), remaining: [...seed.plan.remaining], unverified: seed.plan.unverified.map((u) => ({ ...u })), openProblems: [], harnessProblems: seed.plan.harnessProblems.map((h) => ({ ...h })) };
        this.window = seed.window.map((e) => ({ ...e, shownFiles: [...e.shownFiles], notes: [...e.notes] }));
        for (const p of seed.createdThisRun) this.createdThisRun.add(p);
        // docs/AGENT-LOOP-DESIGN.md §3.3: an agent run never adopts the parent's run — its step number belongs to the parent, so
        // `testsCurrent` against this run's steps would call a follow-up verified (the driver reads it from `ctx.seed.lastTestRun`)
        this.lastTestRun = this.mode !== 'agent' && seed.lastTestRun ? { ...seed.lastTestRun } : null;
        this.lastChangeStep = null;
        this.undoLog = [...(seed.undoLog ?? []), ...(init.opts.undoLog ?? [])].slice(-UNDO_LOG_MAX);
        this.seeded = true;
      } else {
        this.undoLog = [...(init.opts.undoLog ?? [])].slice(-UNDO_LOG_MAX);
      }
    }
    this.restoredSpentUsd = restoredSpentUsd;
    // docs/COORDINATION-DESIGN.md §8: the context policy — the optional state fields restored, un-checkpointed steps folded into the
    // history like the window above (a prepared loader folds the window, not the history: rows past the newest history step fold here)
    // §8.2: the budget is model-aware AND money-aware — the run cap and the step count are the second term
    // contract 1.4 (§8.2, §14 Q4): the model's window comes from `contextPolicy.windowTokens`, else the pricing table's column
    const pricedWindow = init.opts.generatorPricing?.contextTokens;
    this.contextPolicy = resolveContextPolicy(
      init.opts.contextPolicy?.windowTokens === undefined && pricedWindow !== undefined ? { ...init.opts.contextPolicy, windowTokens: pricedWindow } : init.opts.contextPolicy,
      {
        spendCapUsd: init.opts.limits.spendCapUsd,
        maxSteps: init.opts.limits.maxSteps,
        ...(init.opts.generatorPricing?.inputPerM !== undefined ? { inputPerM: init.opts.generatorPricing.inputPerM } : {}),
      },
    );
    this.contextEnabled = this.contextPolicy.view === 'relaxed' && (this.mode === 'jev-on' || this.mode === 'jev-off' || this.mode === 'llm-jev');
    this.filesInView = new FilesInView(workspaceFilesInViewDeps(this.workspace), () => this.clock());
    // review finding 28 / D5: under `view: 'legacy'`, and in the modes that never read it, none of §8 exists
    if (this.contextEnabled) {
      if (init.resume) {
        // §9.3 / §10: a state.json (possibly mirrored from another device) is untrusted input — every addition is validated
        const s: ContextCheckpointExtension = readContextExtension(init.resume.state, this.contextPolicy.historySteps);
        this.history = s.history ?? [];
        this.fileCache = s.fileCache ?? [];
        this.fileMemory = s.fileMemory ?? {};
        this.summaryAt = s.summaryAt ?? null;
        // §8.6 (F26): the kept items ride the checkpoint like `history` and `fileCache`. The human `/keep` items
        // inside them are the ONLY channel a human item has today (`/keep` is `src/tui`'s), so a resume that
        // dropped them would lose the one part of the list the code cannot re-derive.
        this.kept = readKeptItems(init.resume.state);
        this.compactions = s.compactions ?? 0;
        this.lastCompactionAt = s.lastCompactionAt ?? null;
        const newest = this.history[this.history.length - 1]?.step ?? 0;
        let folded = 0;
        for (const rec of [...init.resume.foldedSteps].sort((a, b) => a.step - b.step)) {
          if (rec.step <= newest || rec.step > this.step) continue;
          this.history = foldHistoryRecord(this.history, rec, this.contextPolicy.historySteps);
          folded += 1;
        }
        // §8.6 trigger 4 / review finding 53 + D20: compact on resume ONLY when the folded rows pushed entries out of the
        // history window, so a resume-heavy run sees the same history as an uninterrupted one and `compactions` cannot drift
        this.pendingResumeCompaction = folded > 0 && this.history.length >= this.contextPolicy.historySteps;
      } else {
        // §8.3: a follow-up starts with the parent's window as its history (the generator's `## Recent steps` is derived from
        // the same records as Jev's `recent`, so a seeded run sees the parent's steps exactly as the 4-entry window shows
        // them; the parent's `outputs/` live in the parent's run dir, so no pointer is carried across)
        this.history = (init.opts.seed?.window ?? []).map(seedHistoryEntry);
        // §8.4: the human's @-mentions enter the cache pinned `human` (evicted last)
        for (const rel of init.opts.seed?.pinnedFiles ?? []) this.fileCache = touchFile(this.fileCache, rel, 'human', 0);
      }
    }
    this.contextUsage = restoredContextUsage(this.contextExtension(), this.contextPolicy.budget, this.contextPolicy.compaction);
    // contract 1.4 (W2b), §4.1 / §3.3: the ledger's engine side. Constructed here and NOT started: `start()` is
    // §3.3 point 1, at `run:ready`, so a refused resume and a constructor throw write no heartbeat at all.
    const co = init.opts.coordination;
    this.coord =
      co === undefined || co.ledger === null
        ? null
        : createCoordination({
            options: co,
            source: init.opts.session?.source ?? 'cli',
            base: this.heartbeatBase(co.ledger),
            emit: (e) => {
              this.emit(e);
            },
            monotonicNow: () => this.clock(),
            now: () => Date.now(),
            redact: this.redact,
          });
    // §8.2 / review D8: a model whose window is smaller than the floor is a run-shaping fact, not a silent clamp
    if (this.contextEnabled && this.contextPolicy.budget.windowTooSmall) {
      this.pendingWindowNotice = `context budget clamped to ${this.contextPolicy.budgetChars} chars — the generator's ${this.contextPolicy.windowTokens}-token window is smaller than the ${CONTEXT_BUDGET_MIN_CHARS}-char floor`;
    }
    // TUI-DESIGN §15.2 constructor row (both branches): the initial directive is queued exactly like a steer (same bounds, same
    // deferred steer:queued line after run:ready) and consumed at the first step start
    if (typeof init.opts.humanDirective === 'string') this.steer(init.opts.humanDirective);
    // TUI-DESIGN §9.2: the session set starts with the thresholds earlier runs already crossed (seeded from the parent meter's totals)
    const parent = init.opts.meter.snapshot().parent;
    this.announcedSession = parent ? seedAnnounced(parent.totalUsd, parent.capUsd) : new Set<BudgetPct>();
  }

  /** TUI-DESIGN §8.6: queue one already sanitised, trimmed and clipped directive (steer() did the checks). */
  private queueDirective(text: string): PendingDirective {
    const directive: PendingDirective = { text, at: nowIso(), index: this.steerSeq++ };
    this.pendingDirectives.push(directive);
    return directive;
  }

  /** finish() in flight or run() resolved: nothing may be queued, withdrawn, paused or annotated any more (§8.6). */
  private isFinished(): boolean {
    return this.finishing || this.lastResult !== null;
  }

  /**
   * TUI-DESIGN §8.6 / §15.2: emit steer, unsteer, pause and secret-ack items now, or — before run() — hold them for the
   * announcement right after run:ready, so transcript.log, --plain and the TUI all see run:start first.
   */
  private announce(events: readonly EngineEvent[]): void {
    if (!this.started) {
      this.deferredAnnouncements.push(...events);
      return;
    }
    for (const e of events) this.emit(e);
    this.emitStatus();
  }

  private flushDeferredAnnouncements(): void {
    if (this.deferredAnnouncements.length === 0) return;
    const events = this.deferredAnnouncements;
    this.deferredAnnouncements = [];
    for (const e of events) this.emit(e);
    this.emitStatus();
  }

  /** §9: a stored budget stop whose limit was not raised ends the resumed run immediately. */
  private storedStopBlocks(s: CheckpointState, r: StopReason | null): StopReason | null {
    if (r === null) return null;
    const lim = this.opts.limits;
    if (r === 'complete') return this.opts.resume?.force ? null : 'complete';
    if (!isPlainStopBudget(r)) return null;
    switch (r) {
      case 'spend_cap':
        return s.spend.totalUsd >= lim.spendCapUsd ? r : null;
      case 'max_steps':
        return s.step >= lim.maxSteps ? r : null;
      case 'wall_time':
        return s.wallMsUsed >= lim.maxWallMs ? r : null;
      case 'max_replans':
        return s.loopDetector.replanCount >= lim.maxReplans ? r : null;
      case 'token_cap':
        // TUI-DESIGN §8.7 / §9.5: refused until /budget max-generator-tokens <n> raised the limit (no cap now = raised)
        return lim.maxGeneratorTokens !== undefined && this.generatorTokens >= lim.maxGeneratorTokens ? r : null;
    }
  }

  // -------------------------------------------------------------------------------------
  // Engine surface
  // -------------------------------------------------------------------------------------

  /**
   * §3.3: the identity half of this run's heartbeat — fixed for the run's life, except `repo.repoKey`, which may
   * arrive after `run:ready` and is re-derived by `ledger.setIdentity`. Every free-text leaf is redacted and clipped
   * here as well as by the writer, because the 4 KiB cap is a refusal and a task title is the likeliest overflow.
   */
  private heartbeatBase(ledger: NonNullable<NonNullable<EngineOptions['coordination']>['ledger']>): HeartbeatBase {
    const self = ledger.self;
    const session = this.opts.session;
    const g = this.gitMeta;
    const head = g.head;
    return {
      deviceId: self.deviceId,
      label: self.label,
      host: self.host,
      user: self.user,
      pid: process.pid,
      ...(self.hostKey !== undefined ? { hostKey: self.hostKey } : {}),
      ...(self.bootId !== undefined ? { bootId: self.bootId } : {}),
      bootAt: self.bootAt,
      jevcode: VERSION,
      runId: this.runId,
      sessionId: session?.sessionId ?? this.runId,
      // §6.5: a child run has its OWN sessionId and names its parent here, so the picker can indent it and the
      // session meter can fold its spend into the parent's total without guessing from run ids.
      parentSessionId: session?.parentSessionId ?? null,
      parentRunId: session?.parentRunId ?? null,
      source: session?.source ?? 'cli',
      title60: session?.title === undefined ? null : this.redact(session.title).slice(0, 60),
      task60: this.redact(this.opts.task).slice(0, 60),
      claim: ledger.claim,
      repo: {
        wsKey: self.wsKey,
        repoKey: self.repoKey,
        remoteKey: self.remoteKey,
        basename: basename(this.workspace.root),
        branch: head === null ? null : head.kind === 'detached' ? null : head.name,
        head: head === null ? null : head.kind === 'unborn' ? null : head.oid,
        dirtyAtStart: this.dirtyAtStart.size > 0,
        linkedWorktree: g.linkedWorktree,
        worktreeSlug: null,
      },
      mode: this.mode,
      maxSteps: this.opts.limits.maxSteps,
      maxWallMs: this.opts.limits.maxWallMs,
      startedAt: nowIso(),
    };
  }

  /**
   * §3.3 point 4: the moving half of the heartbeat, derived from the flags `emitStatus` already reads — one place,
   * so the status line, `sessions who` on another device and the resume card can never disagree about this run.
   */
  private heartbeatDynamic(): Partial<HeartbeatDynamic> {
    const snap = this.opts.meter.snapshot();
    const action = this.draft?.proposal?.action ?? null;
    const plan = this.plan;
    return {
      phase: this.runPhase(),
      step: this.step,
      stage: this.currentStage,
      action80: action === null ? null : this.redact(summariseAction(action)).slice(0, 80),
      pausing: this.pauseRequested && this.lastResult === null,
      pauseNow: this.pauseNow && this.lastResult === null,
      blocked: this.blocked?.kind ?? null,
      retrying: this.retrying === null ? null : { side: this.retrying.side, attempt: this.retrying.attempt },
      stopReason: this.stopReason,
      plan: {
        done: plan.done.length,
        remaining: plan.remaining.length,
        unverified: plan.unverified.length,
        // §3.3: `next3` is what a peer reads to know whether to start on the same file — the plan, not the prose
        next3: plan.remaining.slice(0, 3).map((t) => this.redact(t).slice(0, 80)),
      },
      touchedRecent: [...this.touchedRecent],
      spend: { generatorUsd: snap.generator.costUsd, jevUsd: snap.jev.costUsd, sessionUsd: snap.parent?.totalUsd ?? null, capUsd: snap.capUsd },
      tokens: { used: this.generatorTokens, cap: this.opts.limits.maxGeneratorTokens ?? null },
      wallMs: this.wallMsUsed(),
      // §3.3 / §12.0.3: the meter a peer's `sessions who` row shows, filled from the ONE `ContextUsage` the status
      // event carries. `budgetTokens` is the PROMPT BUDGET and `windowTokens` the model's own window, so a peer can
      // print `ctx 41% · budget 70k of 128k` without re-deriving either — and neither is a second definition here.
      context: {
        pct: this.contextUsage.pct,
        files: this.contextUsage.files,
        historyEntries: this.contextUsage.historyEntries,
        summaryAt: this.contextUsage.summaryAt,
        tokensInWindow: this.contextUsage.tokensInWindow,
        budgetTokens: this.contextUsage.budgetTokens,
        windowTokens: this.contextUsage.windowTokens,
        compactions: this.contextUsage.compactions,
      },
      lockHeld: this.lockHeld,
    };
  }

  /**
   * §4.2, the `coordinate` micro-stage's engine half: the gate is run inside `this.stage()` so it emits
   * `stage:start` / `stage:end` / `status` like every other stage, its wall lands in `StepTiming.coordinateMs`, and
   * the inline wait lands in `coordWaitMs` (subtracted from `harnessMs`).
   *
   * Returns `null` to proceed, or the transcript line of a rule-1 discard. It never throws: a ledger fault is the
   * ledger's own notice (`⇄ off (<code>)`) and the step proceeds — coordination is an aid, not a gate on the run
   * being able to run at all (§2.1 rule 3).
   */
  private async runCoordinate(draft: StepDraft, step: number): Promise<string | null> {
    const coord = this.coord;
    const proposal = draft.proposal;
    if (coord === null || proposal === null) return null;
    // §3.5 / §12.0.1 rule 5: the added watch roots are walked ONCE before the first check, so `clear` is a fact
    // rather than ignorance. Every later step reads the already-warm fold.
    if (this.coordReady !== null) {
      await this.coordReady;
      this.coordReady = null;
    }
    const head = this.gitMeta.head;
    const t0 = this.clock();
    let outcome: CoordinateOutcome;
    try {
      outcome = await this.stage('coordinate', () =>
        coord.coordinate({
          step,
          action: proposal.action,
          targets: draft.patchTargets.map((t) => t.path),
          branch: head === null || head.kind === 'detached' ? null : head.name,
          head: head === null || head.kind === 'unborn' ? null : head.oid,
          // §8.4: `check()` wants "the sha the proposal was built on" per path; `FileMemory` keeps a richer entry, so
          // the projection is taken here rather than widening the ledger's input to a shape it has no use for.
          fileMemory: Object.fromEntries(Object.entries(this.fileMemory).map(([rel, e]) => [rel, e.sha12])),
          // §11 row 23: a case-folding volume is the ledger's own probe (`probeCaseInsensitive`), not a fact the
          // engine holds; until the surface passes it in, the exact-match reading is the conservative one — it can
          // miss a conflict on a folding volume, never invent one.
          caseFold: false,
          ask: this.opts.blocker === undefined ? null : (req) => this.awaitCoordinationPane(req),
          blockingId: () => this.nextBlockingId(),
          signal: this.signal,
          currentSha: (paths) => hashTargets(this.workspace.root, paths),
        }),
      );
    } catch (e) {
      // the ledger classifies its own errno into one notice; the step is never held by a failure to coordinate
      this.emit({ type: 'notice', step, kind: 'coordination', level: 'warn', text: `coordination: the claim gate failed (${e instanceof Error ? this.redact(e.message) : String(e)}) — the step proceeds uncoordinated` });
      return null;
    }
    draft.timing.coordinateMs += Math.max(0, this.clock() - t0);
    draft.timing.coordWaitMs += outcome.waitedMs;
    if (outcome.kind === 'proceed') {
      draft.coord = outcome.coord;
      return null;
    }
    if (outcome.kind === 'stale') {
      // §4.2 suspension check: the PROCESS was frozen and the targets moved under it. A rule-1 discard with a
      // `replan` problem, never a conflict — nobody is holding anything; the proposal is simply about old bytes.
      this.plan = {
        ...this.plan,
        harnessProblems: boundHarnessProblems([...this.plan.harnessProblems, { kind: 'replan', text: `targets changed while this session was suspended (${outcome.changed.slice(0, 3).join(', ')})`, step: step + 1 }], PLAN_MAX_HARNESS_PROBLEMS),
      };
      return `step ${step} discarded: the targets changed while this session was suspended`;
    }
    draft.coord = outcome.coord;
    // §4.2: in `jev-on` the human review confirm has already approved this step, so the line says so plainly —
    // "approved but not executed" is the one wording that does not read as a bug report.
    return `step ${step} approved but not executed: coordination chose ${outcome.kind}`;
  }

  /**
   * §4.3 step 4: the strict claim wait's human pane, through the EXISTING blocker seam. `this.blocked` is set for
   * its duration so the status line, `pausedWord` and the heartbeat all read `lease-conflict`, and `pause()` finds a
   * pane to wake (P6): it aborts the `blockWaker` and never the shared controller, so the answer is deterministically
   * `'pause'` and the step is a resumable discard.
   */
  private async awaitCoordinationPane(req: BlockingRequest): Promise<BlockingAnswer> {
    const previous = this.blocked;
    this.blocked = req;
    this.emitStatus();
    try {
      return await this.awaitBlocker(req);
    } finally {
      this.blocked = previous;
      this.emitStatus();
    }
  }

  /**
   * contract 1.4 (W2b), §9.3 / §11 rows 31 and 51: the fork fence. Cheap (one map read over the already-folded
   * ledger), so it runs at every loop top as well as once at `run:ready` — a peer that resumes this run while we are
   * mid-step must be seen at the NEXT boundary, not at the end of the run.
   *
   * Only an AUTHENTICATED superseding claim stops anything. An unverified one is a notice and nothing else, because
   * a forged record in a shared folder can produce it and a stop that a stranger can trigger is a denial of service.
   */
  private checkFork(): void {
    if (this.coord === null || this.forkStop !== null) return;
    const v = this.coord.forkGate(this.runId);
    if (v === null) return;
    if ('stop' in v) {
      this.forkStop = v.stop;
      return;
    }
    if (this.warned.has('fork-unverified')) return;
    this.warned.add('fork-unverified');
    this.emit({ type: 'notice', step: null, kind: 'coordination', level: 'warn', text: v.notice });
  }

  /**
   * §9.3, the resume gate: a claim epoch published by another device that outranks every epoch this one minted.
   * Awaited ONCE, before the first step of a resumed run — it reads signed `claims.json` projections, which is the
   * only evidence available when the peer that took the run over is currently offline.
   */
  /**
   * contract 1.4 (COORDINATION-DESIGN W0 item 1, §3.2 / §9.3): persist one `claims[]` mint in `run.json`.
   *
   * The row is this process's own claim (`authority: 'self'` — this device minted it) and the high-water mark is
   * raised to it; the store appends and caps at `MAX_CLAIMS_PER_RUN` and takes the MAX of the two epoch marks, so a
   * resumed run accumulates its incarnations and never lowers the bar. Fire-and-forget on the meta queue like every
   * other `updateMeta`: coordination never delays a step, and a run with no ledger never reaches here, which is why
   * such a run's `run.json` carries neither member.
   */
  private persistClaimMint(): void {
    if (this.coord === null) return;
    const claim = this.coord.ledger.claim;
    if (this.localClaims.some((c) => c.epoch === claim.epoch && c.deviceId === claim.deviceId)) return;
    const row: RunClaimRow = { epoch: claim.epoch, deviceId: claim.deviceId, at: claim.at, authority: 'self' };
    this.localClaims.push(row);
    this.claimEpochHigh = Math.max(this.claimEpochHigh, claim.epoch);
    this.persist(this.store.updateMeta({ claims: [row], claimEpochHigh: this.claimEpochHigh }), CHECKPOINT_FILES.meta);
  }

  private async checkResumeClaim(): Promise<void> {
    if (this.coord === null || !this.resumed) return;
    // the epochs THIS device minted: `RunMeta.claims[]` and `claimEpochHigh` as `run.json` recorded them (W0 item 1
    // — the set the fold can no longer see, because ended heartbeats are GC'd after 24 h), this process's own claim,
    // and the one persisted beside the run for a takeover it made with no local run dir.
    const persisted = await this.coord.ledger.readRunClaim(this.runId).catch(() => null);
    const local = [this.coord.ledger.claim.epoch, ...(persisted === null ? [] : [persisted.epoch]), ...this.localClaims.map((c) => c.epoch), ...(this.claimEpochHigh > 0 ? [this.claimEpochHigh] : [])];
    const refusal = await this.coord.claimGate(this.runId, local).catch(() => null);
    if (refusal === null) return;
    const label = this.coord.ledger.fold.devices.get(refusal.deviceId)?.label ?? refusal.deviceId.slice(0, 8);
    this.forkStop = `run ${this.runId} is also live on ${label} (claim ${String(refusal.epoch)} supersedes ${String(Math.max(...local))}) — stopped to avoid a double writer`;
  }

  /**
   * §7.1: the run's lifecycle word, derived in ONE place from the flags that already exist. A strict claim wait is
   * the one `blocked` the engine can be in without a pane, which is why the runtime is asked first.
   */
  private runPhase(): EngineRunPhase {
    if (this.lastResult !== null) return 'ended';
    if (this.aborting) return 'aborting';
    if (this.blocked !== null) return 'blocked';
    const waiting = this.coord?.phase();
    if (waiting !== null && waiting !== undefined) return waiting;
    if (this.pauseRequested) return 'pausing';
    if (!this.started) return 'starting';
    return 'running';
  }

  status(): EngineStatus {
    // docs/COORDINATION-DESIGN.md §12.0.3: `context` rides every status (a subtype until EngineStatus gains the member).
    // Review D5/D18: it is ABSENT — not `0 %` — in the modes and under the pin where no relaxed prompt is built, so
    // `--json=verbose` under `view: 'legacy'` is byte-identical to HEAD and a jev-only run shows no meter that cannot move.
    const status: EngineStatus = {
      // docs/AGENT-LOOP-DESIGN.md §7.5: in agent mode the driver's meter (`AgentContext.reportContext`), absent until its first report
      ...(this.contextEnabled ? { context: this.contextUsage } : this.agentContextUsage !== null ? { context: this.agentContextUsage } : {}),
      step: this.step,
      maxSteps: this.opts.limits.maxSteps,
      wallMs: this.wallMsUsed(),
      maxWallMs: this.opts.limits.maxWallMs,
      stage: this.currentStage,
      spend: this.opts.meter.snapshot(),
      stopReason: this.stopReason,
      // TUI-DESIGN §15 item 13
      maxReplans: this.opts.limits.maxReplans,
      replans: this.detector.replanCount(),
      pausing: this.pauseRequested && this.lastResult === null,
      pendingDirectives: this.pendingDirectives.length,
      blocked: this.blocked?.kind ?? null,
      retrying: this.retrying,
      generatorTokens: { used: this.generatorTokens, cap: this.opts.limits.maxGeneratorTokens ?? null },
      // TUI-DESIGN-2 §2.4 / §2.6: the `/jev` line-2 suffix reads one value
      jevCostBasis: this.jevCostBasis(),
      // contract 1.4 (COORDINATION-DESIGN §7.2, §12.0.2)
      pauseNow: this.pauseNow && this.lastResult === null,
      pausePoint: this.pausePoint,
      // contract 1.4 (W2b) (§3.6, §7.1, §6.1): the coordination zone, the lifecycle word and the sub-work rows.
      // All three are ABSENT with no ledger, so `--json=verbose` on a run without coordination is byte-identical.
      ...(this.coord !== null ? { phase: this.runPhase(), coordination: this.coord.status(), subwork: this.coord.subworkRows() } : {}),
      // contract 1.9 (Fastlane) §8.1 (F25): what this engine RESOLVED, so a bench summary can be checked against the
      // run instead of against its own intention. All three are read once at construction and never move.
      //
      // Review defect A8: a CONDITIONAL spread, in the same shape as the coordination triple above and for the
      // same reason — `status` rides the `--json=verbose` NDJSON stream, and writing the member unconditionally
      // added one to every line of every mode, including every control arm of the §8 head-to-head. Absent is
      // `{ s2: 'off', routers: 'off', fastPath: 'off' }` and says so in the type.
      ...this.mechanismsMember(),
    };
    return status;
  }

  /**
   * contract 1.9 (Fastlane) §8.1 (F25) / review defect A8: the ONE place the three mechanisms are projected, for
   * `EngineStatus` and for `CheckpointState` alike. Empty — so the member is ABSENT — when all three resolved
   * off, which is every control arm; a reader that sees nothing has read `off / off / off`.
   */
  private mechanismsMember(): Pick<EngineStatus, 'mechanisms'> {
    const routers = routersOn(this.mode, this.opts.routers) ? 'on' : 'off';
    if (this.s2 === 'off' && routers === 'off' && this.fastPathOption === 'off') return {};
    return { mechanisms: { s2: this.s2, routers, fastPath: this.fastPathOption } };
  }

  /** TUI-DESIGN-2 §2.4: `table` when every Jev request of this process was table-priced, `provider` when every one carried `usage.cost`, `mixed` otherwise; null before any. */
  private jevCostBasis(): JevCostBasis | null {
    const { table, provider } = this.jevBasisCounts;
    if (table === 0 && provider === 0) return null;
    return table > 0 && provider > 0 ? 'mixed' : table > 0 ? 'table' : 'provider';
  }

  snapshotState(): CheckpointState | null {
    try {
      return this.buildCheckpointState();
    } catch {
      return this.lastSnapshot;
    }
  }

  abort(reason: 'human_abort' | 'signal' | 'error', opts: { signal?: SignalName; error?: SerializedError } = {}): void {
    trace(`abort(${reason}) aborting=${this.aborting} stage=${this.currentStage} step=${this.step} lastResult=${this.lastResult !== null}`);
    // After run() resolved there is nothing to stop and the final checkpoint is already written;
    // installing the 'exit' writer here would leave a listener that rewrites state.json at exit.
    if (this.lastResult !== null) return;
    // contract 1.1 (TUI-DESIGN §15 item 15): the signal name refines the exit code (§13.5); an 'error' abort carries the fatal error (§13.4)
    if (opts.signal) this.signalName = opts.signal;
    if (reason === 'error' && opts.error) this.fatalSerialized = opts.error;
    if (this.aborting) {
      // Second press while shutting down: synchronous last-resort write, then exit (§11). finish() may not have run
      // yet (the first abort's tree kill or the rejected stage can still be settling), so the snapshot written here
      // records the stop and the §9.1 rule-1 discard itself; otherwise state.json would carry stopReason null and no
      // `interrupted` for the discarded step (observed in a live interactive session).
      if (this.lastResult === null) {
        this.markLastResort(reason);
        this.forceExit(exitCodeFor('signal', undefined, false, this.signalName ?? undefined));
      }
      return;
    }
    this.aborting = true;
    if (!this.controller.signal.aborted) this.controller.abort(new AbortError(reason, this.signalName));
    else if (isAbortError(this.controller.signal.reason) && this.controller.signal.reason.reason === 'human_pause') {
      // contract 1.4 (COORDINATION-DESIGN §7.2 "a later abort() still wins", §11 row 38): the shared controller already carries the
      // pause-now reason; classifyStop() and markLastResort prefer this one, so Esc Esc / SIGTERM never finish as human_pause
      this.abortOverride = new AbortError(reason, this.signalName);
    }
    void this.sandbox.killAll().catch(() => undefined);
    const handler = (): void => {
      try {
        // the process is exiting before finish() completed: record the stop and the discarded step (§9.1 rule 1)
        this.markLastResort(reason);
        const snap = this.snapshotState();
        if (snap) this.store.writeStateSync(snap);
        // contract 1.4 (W2b), §3.3 point 6: one bounded synchronous `phase:'ended'` marker, LOCAL ONLY — never the
        // mirror, because a synchronous write to an unmounted share would hold the exit handler for the kernel's
        // timeout. Expiry is the truth; the marker is a courtesy for the next process. After writeStateSync,
        // before releaseLock.
        this.coord?.finishSync({ phase: 'ended', stopReason: reason });
      } catch {
        // nothing more can be done on 'exit'
      }
      this.releaseLock();
    };
    this.exitHandler = handler;
    process.on('exit', handler);
  }

  /**
   * Before a synchronous last-resort write: the stop reason finish() would have set, and the in-flight step as a
   * rule-1 discard (`interrupted`), so `--resume` restarts that step and the run reads as stopped, not crashed.
   */
  private markLastResort(reason: 'human_abort' | 'signal' | 'error'): void {
    // contract 1.4 (§7.2): a pause-now already set human_pause; the abort that followed is the stop
    if (this.stopReason === null || this.stopReason === 'human_pause') this.stopReason = reason;
    if (this.interrupted === null && this.draft !== null && this.draft.step > this.step) {
      this.interrupted = { step: this.draft.step, stage: this.currentStage === 'idle' ? 'intent' : this.currentStage, proposal: this.draft.proposal };
    }
  }

  private forceExit(code: number): void {
    try {
      const snap = this.snapshotState();
      if (snap) this.store.writeStateSync(snap);
    } catch {
      // fall through to exit
    }
    this.releaseLock();
    const exit = this.opts.exit ?? ((c: number): never => process.exit(c));
    exit(code);
  }

  /** TUI-DESIGN §8.5: `run.lock` is removed in finish() and by the 'exit' handler; only this process's own lock, never throws. */
  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    releaseRunLock(this.runDir, { pid: process.pid });
  }

  // -------------------------------------------------------------------------------------
  // contract 1.1 (TUI-DESIGN §15 item 15): steering, pause, retry wake, renderer lines
  // -------------------------------------------------------------------------------------

  /**
   * Queue a human directive for the next step start (§8.6). Raw in memory; every artefact sees it
   * through the redacting emit / the store's write-time redaction. Consumed by applyPendingDirectives at
   * the loop top; a queue that outlives the run is checkpointed and restored so nothing is lost.
   */
  steer(text: string, opts: { secretsAcked?: number } = {}): SteerResult {
    const queued = this.pendingDirectives.length;
    // TUI-DESIGN §8.6: finished → empty → full, in that order; finished includes a finish() in flight (the final snapshot is
    // already built, so a directive accepted now would be confirmed to the human and never persisted)
    if (this.isFinished()) return { ok: false, reason: 'finished', queued };
    const trimmed = clipText(sanitizeStream(text).trim(), DIRECTIVE_MAX_CHARS);
    if (trimmed === '') return { ok: false, reason: 'empty', queued };
    if (queued >= MAX_PENDING_DIRECTIVES) return { ok: false, reason: 'full', queued };
    const directive = this.queueDirective(trimmed);
    const events: EngineEvent[] = [];
    // TUI-DESIGN §8.6: the ack is true — the secret does reach the generator; the count only, never the value (P59)
    if (opts.secretsAcked !== undefined && opts.secretsAcked > 0) events.push({ type: 'secret-ack', step: this.step + 1, count: opts.secretsAcked });
    events.push({ type: 'steer:queued', step: this.step + 1, index: directive.index, text: directive.text, queued: this.pendingDirectives.length });
    this.announce(events);
    return { ok: true, index: directive.index, queued: this.pendingDirectives.length };
  }

  /** Withdraw the newest queued directive; null when none — or when the run is finished (the queue is already on disk, §8.6). */
  unsteer(): PendingDirective | null {
    if (this.isFinished()) return null;
    const d = this.pendingDirectives.pop();
    if (d === undefined) return null;
    this.announce([{ type: 'steer:withdrawn', step: this.step + 1, index: d.index }]);
    return d;
  }

  /**
   * Stop with 'human_pause' at the next loop top (§9.1 rule 1: the in-flight step commits whole first); idempotent.
   * contract 1.4 (COORDINATION-DESIGN §7.2, §12.0.2): `at: 'now'` is the soft interrupt — synchronous, in order: (1) the draft
   * snapshot → `cache/step-<n>.json` (the proposal, its targets' hashes, the partial text, the arrived LLM samples), (2) the
   * flags and `pause:requested`, (3) an awaited pane wakes with 'pause' (P6), else the shared controller aborts with
   * `AbortError('human_pause')` unless `execute` is in flight (P4: WAIT, never kill — the judge is skipped after it). `now`
   * after `step` upgrades (the snapshot and the abort happen then); `step` after `now` is a no-op; nothing once finish() began.
   */
  pause(opts: PauseOptions = {}): void {
    if (this.isFinished()) return;
    if (opts.by !== undefined) this.pauseBy = opts.by;
    if ((opts.at ?? 'step') === 'step') {
      if (this.pauseRequested) return;
      this.pauseRequested = true;
      this.announce([{ type: 'pause:requested', step: this.step + 1 }]);
      // P6: a pane awaited at the loop top has nothing in flight — wake it so the loop top finishes with human_pause now
      if (this.blockWaker !== null) this.blockWaker.abort();
      return;
    }
    if (this.pauseNow) return;
    this.pauseNow = true;
    const first = !this.pauseRequested;
    this.pauseRequested = true;
    const draft = this.draft;
    // (1) a stage is in flight (the draft is open) and nothing ran yet: the snapshot is what /resume --replay restores; once
    // execute started the step commits whole instead; a discarded draft awaiting a pane is closed — nothing is in flight (P6)
    const inFlight = draft !== null && !draft.closed && this.started;
    // docs/AGENT-LOOP-DESIGN.md §10 Pause: agent mode writes no step replay cache — the driver re-derives the turn from its transcript
    if (inFlight && !draft.executeStarted && this.mode !== 'agent') this.snapshotDraft(draft);
    // (2) the request line once; an upgrade shows in the status (pauseNow) only
    if (first) this.announce([{ type: 'pause:requested', step: this.step + 1 }]);
    else if (this.started) this.emitStatus();
    // (3) a pane is up (installed, or already awaited at the loop top): nothing is in flight — wake it with 'pause' (P6) and
    // never abort the shared controller. The `blocked` half matters between installBlock() and awaitBlocker(): the waker does
    // not exist yet there, and an abort would turn a resumable pane pause into the pane's own stop.
    if (this.blocked !== null || this.blockWaker !== null) {
      this.blockWaker?.abort();
      return;
    }
    // (4) the stage in flight is cut through the shared controller; `execute` is never cut (P4, §11 row 29)
    if (inFlight && this.currentStage !== 'execute' && !this.controller.signal.aborted) this.controller.abort(new AbortError('human_pause'));
  }

  /**
   * contract 1.4 (COORDINATION-DESIGN §7.4, §12.0.2): `end` = pause (at step, or now) + `RunMeta.ended = { at, by }` written with
   * the final state, so `createEngine` requires --force to reopen. No new StopReason (§2.1 rule 10). Idempotent: a second end()
   * keeps the first requester; end() after pause() adds the mark; nothing once finish() began.
   */
  end(opts: EndOptions = {}): void {
    if (this.isFinished()) return;
    const by = opts.by ?? 'human';
    const first = this.endRequested === null;
    if (first) this.endRequested = { by };
    this.pause({ at: opts.at ?? 'step', ...(by === 'human' ? { by: 'self' as const } : {}) });
    if (first) this.announce([{ type: 'transcript', step: null, level: 'info', text: `end requested (${by}): the run stops paused after this point; /resume ${this.runId} --force reopens` }]);
  }

  /**
   * contract 1.4 (COORDINATION-DESIGN §5.4, §12.0.2 P8): a coordination message addressed to this run. `pause` / `end` apply as
   * `pause({ at, by: 'peer:<sid8>' })` / `end({ at, by: 'remote' })` — `text` naming `now` selects the soft interrupt; the caller
   * (the TUI, which owns trust and the `[y] [Y] [n]` row) has already decided the sender may. Every other type is refused until
   * the messaging wave routes it (W3). The outcome says what actually happened (§7.4 idempotency): `applied` when the request
   * changed the run's course, `delivered` when it was already so, `expired` once the run is no longer live.
   */
  deliver(msg: DeliverableMessage): AckOutcome {
    if (this.isFinished()) return 'expired';
    // contract 1.4 (W2b), §5.4: the non-control types. None of them can change the run's course, so none needs a
    // `[y]` and all of them are applied here whatever the sender's authority — what a peer says is a FACT about the
    // repository, rendered inside the prompt's fenced untrusted-data block, never an instruction (§5.4, §8.8).
    if (msg.type === 'steer') {
      // §5.4: a `steer` is a DIRECTIVE, so it is the one fact-shaped type whose authority matters; the caller has
      // already applied §10.3 (trusted + hmac-valid, or same device and same boot) before calling us.
      const r = this.steer(`[session] ${msg.from.label}: ${msg.text}`);
      return r.ok ? 'applied' : 'refused';
    }
    if (msg.type === 'note' || msg.type === 'heads-up' || msg.type === 'handoff' || msg.type === 'who' || msg.type === 'budget' || msg.type === 'review' || msg.type === 'kick' || msg.type === 'land') {
      this.emit({ type: 'notice', step: this.step + 1, kind: 'session', level: 'info', text: `${msg.from.label}: ${this.redact(msg.text)}` });
      return 'delivered';
    }
    if (msg.type === 'request-release') {
      // §5.4 / G1(b): under `advisory` this is a FACT and nothing is delayed — the current step commits and
      // releases as it always would, and the next prompt's `## Other sessions` carries the ask.
      const files = (msg.refs?.files ?? []).slice(0, 8).join(', ');
      this.emit({ type: 'notice', step: this.step + 1, kind: 'session', level: 'info', text: `${msg.from.label} asks you to release ${files.length > 0 ? files : 'the paths it named'}` });
      return 'applied';
    }
    if (msg.type !== 'pause' && msg.type !== 'end') return 'refused';
    const sid = msg.from.sessionId ?? msg.from.runId;
    // §5.3 / §10: a peer's own strings reach `by`, which rides state.json, the heartbeat and an index line — clamp them to
    // the id grammar and 32 chars here, so no record can be widened, split across lines or made to look like another target
    const by: PausePoint['by'] = sid !== null && sid.length > 0 ? `peer:${peerLabel(sid.slice(-PEER_SID_CHARS))}` : `device:${peerLabel(msg.from.label)}`;
    const at: 'step' | 'now' = /\bnow\b/i.test(msg.text) ? 'now' : 'step';
    const before = { requested: this.pauseRequested, now: this.pauseNow, end: this.endRequested !== null };
    if (msg.type === 'pause') this.pause({ at, by });
    else {
      this.pauseBy = by;
      this.end({ at, by: 'remote' });
    }
    const changed = this.pauseRequested !== before.requested || this.pauseNow !== before.now || (this.endRequested !== null) !== before.end;
    return changed ? 'applied' : 'delivered';
  }

  /**
   * §5.4: apply ONE arrival the surface does not have to ask about. `classifyIncoming` has already decided what
   * the sender may do — this only turns the verdict into the engine verb, and returns the outcome the ack records.
   *
   * A message whose verdict was DOWNGRADED is applied as the reduced action, never as the one it asked for: an
   * untrusted `steer` is a note, and it is a note that says so.
   */
  private applyIncoming(msg: DeliverableMessage, d: MessageDisposition): AckOutcome {
    if (d.refused !== null && d.action === 'note' && d.downgraded) {
      this.emit({ type: 'notice', step: this.step + 1, kind: 'session', level: 'warn', text: `${msg.from.label}: ${this.redact(msg.text)} (${d.refused})` });
      return 'refused';
    }
    return this.deliver({ ...msg, type: d.action });
  }

  /**
   * §7.2 step 1–2: the draft snapshot, taken synchronously, written through the store's cache chain (`persist`: a failure is a
   * notice, never a blocker — the card then offers no `[r]`). The targets' hashes are computed on the way out (async, bounded by
   * the images.ts budget) and ride the same promise, which finish() awaits for at most PAUSE_CACHE_BOUND_MS.
   */
  private snapshotDraft(draft: StepDraft): void {
    const step = draft.step;
    const rel = stepCacheRel(step);
    const proposal = draft.proposal;
    const arrived = draft.arrivedSamples.map((a) => ({ ...a }));
    const rels: string[] = [];
    if (proposal !== null) {
      for (const t of [...draft.patchTargets.map((t) => t.path), ...proposalPaths(proposal.action)]) if (!rels.includes(t)) rels.push(t);
    }
    const targets = rels.slice(0, REPLAY_HASH_MAX_FILES);
    const intent = draft.intent;
    const snap: Omit<StepCache, 'targets'> = {
      v: 1,
      step,
      stage: this.currentStage,
      proposal,
      patchTargets: draft.patchTargets.map((t) => ({ ...t })),
      risk: draft.risk,
      matchesIntent: draft.matchesIntent,
      intent: intent === null ? null : { intent: intent.intent, answer: intent.answer, verdict: intent.verdict, probability: intent.probability, confidence: intent.confidence, pairedNoul: intent.pairedNoul, planStillValid: intent.planStillValid },
      proposer: draft.proposer,
      contextFiles: [...draft.contextFiles],
      directive: draft.directive,
      partial: draft.partialChars > 0 ? { text: sanitizeStream(draft.partialText), chars: draft.partialChars } : null,
      llmRound: this.mode === 'llm-jev' && draft.llmRounds > 0 ? { goalId: draft.llmGoal?.goalId ?? null, round: draft.llmGoal?.round ?? draft.llmRounds - 1, arrived } : null,
      // §7.2 step 2: the same pair goes into `interruptedDetail`, and a replay serves the file only when the two agree
      resumes: this.resumes + 1,
      at: nowIso(),
    };
    // §12.0.2: exactly what the file carries — the discard and finish() read these, never the draft as it looks later
    const wrote = {
      step,
      rel,
      resumes: this.resumes + 1,
      at: snap.at,
      hadProposal: proposal !== null,
      arrivedCount: snap.llmRound?.arrived.length ?? 0,
      partialChars: draft.partialChars,
      round: snap.llmRound?.round ?? null,
      llm: snap.llmRound !== null && snap.llmRound.goalId !== null ? { goalId: snap.llmRound.goalId, round: snap.llmRound.round, arrived: arrived.map((a) => a.sample) } : null,
    };
    const write = this.store.writeCache;
    if (write === undefined) {
      this.pauseCache = { ...wrote, done: Promise.resolve({ ok: false, targetsSha: {} }) };
      return;
    }
    const done = hashTargets(this.workspace.root, targets).then(async (targetsSha) => {
      await write.call(this.store, stepCacheName(step), toJson({ ...snap, targets: targets.map((t) => ({ rel: t, sha256: targetsSha[t] ?? null })) }));
      return { ok: true, targetsSha };
    });
    this.persist(done.then(() => undefined), rel);
    this.pauseCache = { ...wrote, done: done.catch(() => ({ ok: false, targetsSha: {} })) };
  }

  /** contract 1.4 (§7.2): the stop classification of the shared signal, the later abort winning over a pause-now */
  private classifyStop(reason: unknown = this.signal.reason): { interrupt: InterruptReason; stop: StopReason } {
    return classifyAbort(this.abortOverride ?? reason);
  }

  /** §12.0.2 P1 / P4 / P5: the point at a step boundary — recorded at the loop top unless a discard already recorded one */
  private recordBoundaryPause(): void {
    if (this.pauseAt !== null) return;
    this.pauseAt = { step: this.step + 1, phase: 'idle', reason: this.pauseLandedInExecute ? 'now-after-execute' : 'step', round: null, cache: null };
  }

  /**
   * contract 1.5 (ORCHESTRATION-DESIGN §4.2 **P9**, [G17]): "delegation accepted". The manifest was confirmed
   * at step n, the parent has nothing left to do until children report, and it stops.
   *
   * [G17] is the whole reason this is its own recorder rather than a call to `recordBoundaryPause()`: P9 is
   * ENGINE-initiated. No human asked, so `by` stays `'self'` and never takes a `peer:` / `device:` form, and
   * every surface that keys off `human_pause` to mean "a human asked" must add the `reason: 'delegate'` case.
   * It is also the only pause point where NOTHING was interrupted — the step committed whole — which is why
   * `resumableAt` is `'boundary'`, `replayable` is false, and the resume card shows no `[r] replay`.
   */
  private recordDelegatePause(step: number): void {
    this.pauseBy = 'self';
    this.pauseAt = { step: step + 1, phase: 'idle', reason: 'delegate', round: null, cache: null };
  }

  /**
   * §12.0.2 P6 / P7: the point at a pane that pause() woke (`pane`) or that the human answered `[t] worktree` (`worktree`,
   * the lease-conflict relocation of §4.3 step 5) — the step that raised the pane is already a rule-1 discard, so its
   * `interruptedDetail` (when one was written) is what `--replay` reads after the relocation.
   */
  private recordPanePause(req: BlockingRequest, reason: 'pane' | 'worktree'): void {
    const detail = this.interrupted !== null ? this.interruptedDetail : null;
    this.pauseAt = { step: this.interrupted?.step ?? this.step + 1, phase: 'pane', reason, round: null, pane: req.kind, cache: detail?.cache ?? null };
  }

  /**
   * §12.0.2 P2 / P3: a rule-1 discard after a pause-now (or an abort that followed one) — the replay detail beside `interrupted`
   * and, for a human_pause, the point itself. `replayable` = a proposal or an arrived sample exists and nothing ran; the cache
   * write's outcome is folded in by finish().
   */
  private noteDiscardDetail(draft: StepDraft, stage: StageName, stop: StopReason): void {
    const cache = this.pauseCache;
    // docs/AGENT-LOOP-DESIGN.md §10 Pause: no cache in agent mode, but a pause-now is still a pause-now — the point says so
    if (this.mode === 'agent' && cache === null && stop === 'human_pause' && this.pauseNow) {
      this.pauseAt = { step: draft.step, phase: stage, reason: 'now', round: null, cache: null };
      return;
    }
    if (cache === null || cache.step !== draft.step) return;
    // §12.0.2 (one definition of `replayable`): what the snapshot WROTE — a proposal in the file, or arrived samples in it —
    // and nothing executed. A sample that resolved in the same tick as the pause is not in the file and does not count.
    const replayable = !draft.executeStarted && (cache.hadProposal || cache.arrivedCount > 0);
    this.interruptedDetail = { cache: cache.rel, resumes: cache.resumes, at: cache.at, targetsSha: {}, replayable, partialChars: cache.partialChars };
    if (stop !== 'human_pause') return;
    this.pauseAt = {
      step: draft.step,
      phase: stage,
      // contract 1.5 (ORCHESTRATION-DESIGN §4.2 P10): the parking confirmer's discard is a review park, not a pause-now
      reason: this.reviewParked ? 'review-needed' : 'now',
      round: cache.round,
      ...(cache.llm !== null ? { llm: { ...cache.llm, arrived: [...cache.llm.arrived] } } : {}),
      cache: cache.rel,
    };
  }

  /**
   * finish(): the pause-now cache write settles (bounded) so `interruptedDetail.targetsSha` / `.replayable` are facts in the final
   * state — for every stop reason (an abort after a pause-now keeps the file for the card, §11 row 38); then, for a human_pause,
   * the PausePoint (§12.0.2) is built from the decided facts before the snapshot is taken, so state.json and the event agree.
   * §7.5: the wait is PAUSE_CACHE_BOUND_MS at most and never outlives `deadlineMs`, the ONE shutdown bound it shares with the
   * final write — so a hung cache chain cannot stretch the shutdown past SHUTDOWN_CHECKPOINT_BOUND_MS.
   */
  private async settlePausePoint(reason: StopReason, deadlineMs: number): Promise<void> {
    const cache = this.pauseCache;
    let cacheOk = false;
    if (cache !== null && this.interruptedDetail !== null && this.interruptedDetail.cache === cache.rel) {
      const waitMs = Math.max(0, Math.min(PAUSE_CACHE_BOUND_MS, deadlineMs - this.clock()));
      // the sleep's wake signal ends the timer the moment the race is over (the write won, or the bound did), so the
      // shutdown never carries a timer nobody waits for; the wake RESOLVES the sleep, so nothing is left unhandled either
      const waker = new AbortController();
      let r: { ok: boolean; targetsSha: Record<string, string | null> };
      try {
        r = await Promise.race([cache.done, sleep(waitMs, undefined, waker.signal).then(() => ({ ok: false, targetsSha: {} as Record<string, string | null> }))]);
      } finally {
        waker.abort();
      }
      cacheOk = r.ok;
      this.interruptedDetail = { ...this.interruptedDetail, targetsSha: r.targetsSha, replayable: this.interruptedDetail.replayable && r.ok };
    }
    if (reason !== 'human_pause') return;
    // §12.0.2: `checkpoint-degraded` (exit 3, resumable false) never reaches a pause point — the state the point promises could not be written
    if (this.checkpointDegraded) return;
    if (this.pauseAt === null) this.recordBoundaryPause();
    const at = this.pauseAt!;
    const detail = at.cache !== null && this.interruptedDetail !== null && this.interruptedDetail.cache === at.cache ? this.interruptedDetail : null;
    this.pausePoint = {
      step: at.step,
      round: at.round,
      phase: at.phase,
      reason: at.reason,
      resumableAt: at.cache !== null && cacheOk ? at.cache : 'boundary',
      replayable: detail !== null && detail.replayable && cacheOk,
      ...(at.pane !== undefined ? { pane: at.pane } : {}),
      ...(at.llm !== undefined ? { llm: { ...at.llm, arrived: [...at.llm.arrived] } } : {}),
      by: this.pauseBy,
      end: this.endRequested !== null,
    };
  }

  /**
   * §7.3 step 3: `EngineOptions.resume.replay` — read `cache/step-<n>.json` for the interrupted step and pass the hash gate;
   * otherwise the step is fresh at intent with one transcript line saying why (§11 row 30).
   */
  private async loadReplay(): Promise<void> {
    const step = this.step + 1;
    // docs/AGENT-LOOP-DESIGN.md §10: agent mode has no replay cache — the driver's transcript IS the paused turn
    if (this.mode === 'agent') {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `replay unavailable in agent mode: the agent re-derives step ${step} from its transcript` });
      return;
    }
    const interrupted = this.interrupted;
    const detail = this.interruptedDetail;
    if (interrupted === null || detail === null || interrupted.step !== step) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `replay unavailable: no paused proposal for step ${step}; fresh step at intent` });
      return;
    }
    // §7.3 step 4: the detail is stamped with the resume counter of the run allowed to replay it; one fresh resume of the
    // step supersedes it for good (runStep renames the file), so a later --replay can never resurrect the rejected proposal
    if (detail.resumes !== this.resumes) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `replay unavailable: the paused proposal for step ${step} was already superseded by a fresh resume (stamped for resume ${detail.resumes}, this is ${this.resumes}); fresh step at intent` });
      return;
    }
    if (!detail.replayable) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `replay unavailable: nothing had arrived when step ${step} paused; fresh step at intent` });
      return;
    }
    const json = this.store.readCache ? await this.store.readCache(stepCacheName(step)) : null;
    const cache = json === null ? null : parseStepCache(json);
    if (cache === null || cache.step !== step) {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `replay unavailable: ${detail.cache} is missing or unreadable; fresh step ${step} at intent` });
      return;
    }
    // §7.2 step 2: the file must be the one this state names — the `{ resumes, at }` pair, never the mere presence of the file
    if (cache.resumes !== detail.resumes || cache.at !== detail.at) {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `replay unavailable: ${detail.cache} belongs to another attempt (written ${cache.at}, the state names ${detail.at}); fresh step ${step} at intent` });
      return;
    }
    const check = await verifyTargets(this.workspace.root, detail.targetsSha);
    if (!check.ok) {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `replay unavailable: targets changed since the proposal (${check.changed.join(', ')}); fresh step ${step} at intent` });
      return;
    }
    this.replayCache = cache;
    const what = cache.proposal !== null ? 'the paused proposal (risk re-checked)' : `${cache.llmRound?.arrived.length ?? 0} arrived LLM sample(s), no generator call for them`;
    this.emit({ type: 'transcript', step: null, level: 'info', text: `replaying step ${step} from ${detail.cache}: ${what}` });
  }

  /**
   * §7.3 step 4: drop the replay detail and rename `cache/step-<n>.json` → `cache/step-<n>.superseded.json`. Called at the top
   * of every step that is not a replay: the bytes stay for the audit trail, the proposal is out of reach for good.
   */
  private supersedeStepCache(): void {
    const detail = this.interruptedDetail;
    this.interruptedDetail = null;
    if (detail === null) return;
    const rename = this.store.renameCache;
    const m = /^cache\/step-(\d+)\.json$/.exec(detail.cache);
    if (rename === undefined || m === null) return;
    const n = Number(m[1]);
    this.persist(rename.call(this.store, stepCacheName(n), stepCacheSupersededName(n)), detail.cache);
  }

  /** the cache for exactly this step, or null; a cached proposal is consumed here, a samples-only cache stays for generate() until the step ends */
  private takeReplay(step: number): StepCache | null {
    // docs/AGENT-LOOP-DESIGN.md §10: no replay cache in agent mode (the agent branch of runStep reads none either)
    if (this.mode === 'agent') return null;
    // ORCHESTRATION-DESIGN §5.7: a harness-seeded proposal (the launch merge, or the [c] / [s] pre-flight step) enters
    // the loop through the SAME door as a replayed one — "do not build a parallel path".
    const seeded = this.takeSeeded(step);
    if (seeded !== null) return seeded;
    const c = this.replayCache;
    if (c === null || c.step !== step) return null;
    if (c.proposal !== null) this.replayCache = null;
    return c;
  }

  /** llm-jev replay: the cached result for this sample of the same prompt, served once; null → the generator is asked */
  private takeCachedSample(draft: StepDraft, req: GenerateRequest, sample: SampleOptions): GenerateResult | null {
    const c = this.replayCache;
    if (c === null || c.step !== draft.step || c.llmRound === null) return null;
    const hash = promptHashOf(req);
    const i = c.llmRound.arrived.findIndex((a) => a.sample === sample.sample && a.purpose === sample.purpose && a.promptHash === hash);
    if (i < 0) return null;
    const [hit] = c.llmRound.arrived.splice(i, 1);
    return hit === undefined ? null : hit.result;
  }

  /**
   * §7.2: the streamed generator chars of the propose call feed the snapshot's partial text (bounded). Only the proposal's
   * own stream counts: an llm-jev sample's chars are its row's (`recordUnfinishedSample`), and counting them would make the
   * card claim a partial proposal that never existed.
   */
  private notePartial(draft: StepDraft, text: string, keepText: boolean): void {
    if (!keepText) return;
    draft.partialChars += text.length;
    const room = PARTIAL_TEXT_MAX_CHARS - draft.partialText.length;
    if (room <= 0) return;
    draft.partialText += text.length <= room ? text : text.slice(0, room);
  }

  /**
   * TUI-DESIGN §13.2 (F12 `[r]`): end the current retry sleep (or the jev-unreachable auto-retry wait) early. The waker
   * is one AbortController per sleep — created by onRetry before each sleep, aborted here, nulled so a second press
   * before the next sleep is a no-op (never a tight loop); false when no retry sleep is active.
   */
  retryNow(): boolean {
    const w = this.retryWaker;
    // llm-jev (docs/LLM-JEV-DESIGN.md §4.8): every in-flight sample's retry sleep is woken as well
    const samples = [...this.sampleWakers.values()];
    this.sampleWakers.clear();
    for (const s of samples) s.abort();
    if (w === null) return samples.length > 0;
    this.retryWaker = null;
    w.abort();
    return true;
  }

  /**
   * contract 1.4 (COORDINATION-DESIGN §8.5, §8.6): `/compact now` — fold the history into the rolling summary at once,
   * outside the 85 % / every-8-steps triggers. A no-op when this run builds no relaxed context (`jev-only`,
   * `view: 'legacy'`, `compaction: 'off'`), when there is nothing foldable, or once finish() began; `context:compacted`
   * reports what it did, exactly as an automatic compaction does.
   */
  compact(): void {
    // docs/AGENT-LOOP-DESIGN.md §7.4: in agent mode `/compact` is a request the driver takes before its next turn
    // (`AgentContext.takeCompactRequest`); the driver's policy decides what `compaction: 'off'` means there
    if (this.mode === 'agent') {
      if (!this.isFinished()) this.agentCompactRequested = true;
      return;
    }
    if (!this.contextEnabled || this.isFinished() || this.contextPolicy.compaction === 'off') return;
    if (foldableCount(this.history) === 0) return;
    this.compactContext(this.step, 'manual');
    this.emitStatus();
  }

  /**
   * A renderer-originated transcript line while the run is live (§15.1): it rides the engine's redacting
   * emit and transcriptSeq, so transcript.log, --plain and the TUI stay line-identical. False once the run
   * finished (or before it started): the renderer then keeps the item local.
   */
  annotate(text: string, opts: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' | 'dim' } = {}): boolean {
    if (!this.started || this.isFinished()) return false;
    // TUI-DESIGN §8.6: text ≤ 600 and the TUI-only body ≤ 12,000, both through sanitizeStream — the raw event reaches --json and
    // every listener, so the bound lives here, not only in itemsFromEvent. The step label names the in-flight step (draft), like
    // every other per-step event, and `[run]` between steps (deviation from §8.6's `this.step > 0 ? this.step : null`, which
    // would label a /why during step 3 as `[step 2]`).
    const detail = opts.detail !== undefined ? clipText(sanitizeStream(opts.detail), ANNOTATE_DETAIL_MAX_CHARS) : '';
    this.emit({
      type: 'notice',
      step: this.draft?.step ?? null,
      kind: 'ui',
      // `dim` is the renderer's quiet grade; `notice.level` has three, so the transcript records it as `info`
      level: opts.level === undefined || opts.level === 'dim' ? 'info' : opts.level,
      text: clipText(sanitizeStream(text), ANNOTATE_TEXT_MAX_CHARS),
      label: opts.label ?? '[ui]',
      ...(detail.length > 0 ? { detail } : {}),
    });
    return true;
  }

  /**
   * contract 1.7 item 2 (TUI-DESIGN-4 §3.5, D-W): one `notice ui` per row, HEAD FIRST, exactly as `--plain`'s
   * `note(head); for (const l of lines) note(l)` loop does — so a command block issued while a run is live writes the
   * same rows to `transcript.log` from the TUI as from `--plain`, and the three sinks match. Returns false when no run
   * is live, exactly like `annotate`, and the caller then keeps the rows local.
   *
   * Edge 1: the loop is ATOMIC with respect to `isFinished()` — liveness is read once, before the first emit, so a
   * listener that pauses (or a run that ends) between two rows can never truncate a block into half a card.
   * Edge 2: at most `BLOCK_LOG_MAX` body rows, then one `… +N more rows`.
   */
  annotateBlock(head: string, rows: readonly string[], opts: { level?: 'info' | 'warn' | 'error' | 'dim'; label?: UiLabel } = {}): boolean {
    if (!this.started || this.isFinished()) return false;
    const step = this.draft?.step ?? null;
    const level = opts.level === undefined || opts.level === 'dim' ? 'info' : opts.level;
    const label = opts.label ?? '[ui]';
    const shown = rows.length > BLOCK_LOG_MAX ? rows.slice(0, BLOCK_LOG_MAX) : rows;
    const overflow = rows.length - shown.length;
    const lines = [head, ...shown, ...(overflow > 0 ? [`… +${overflow} more rows`] : [])];
    for (const line of lines) {
      this.emit({ type: 'notice', step, kind: 'ui', level, text: clipText(sanitizeStream(line), ANNOTATE_TEXT_MAX_CHARS), label });
    }
    return true;
  }

  run(): Promise<RunResult> {
    if (this.finished) return this.finished;
    this.started = true;
    this.jevCache.clear(); // ranked change 2: the answer cache is per RUN, never wider

    this.finished = this.runGuarded();
    return this.finished;
  }

  private async runGuarded(): Promise<RunResult> {
    try {
      return await this.main();
    } catch (e) {
      // run() never rejects: anything escaping the loop is a fatal error stop.
      try {
        this.fatalError = e;
        this.emit({ type: 'error', step: this.draft?.step ?? null, error: serializeError(e, this.redact), fatal: true });
        return await this.finish('error');
      } catch (e2) {
        this.lastResult ??= assembleRunResult({ runId: this.runId, mode: this.mode, reason: 'error', state: this.lastSnapshot ?? this.buildCheckpointState(), error: serializeError(e2, this.redact) });
        return this.lastResult;
      }
    }
  }

  private async main(): Promise<RunResult> {
    // HARNESS-NEXT-DESIGN §4.4 (wave S0): the per-step timing buckets, off unless JEVCODE_TIMELINE is set
    stepTimeline.beginRun(this.runId, this.mode);
    // contract 1.4 (W2b) (COORDINATION-DESIGN §6.5): the child's session tree is a fact on the FIRST event of the
    // run. Conditional, so an ordinary run emits byte-identically to HEAD.
    const parentSessionId = this.opts.session?.parentSessionId ?? null;
    this.emit({
      type: 'run:start',
      runId: this.runId,
      task: this.opts.task,
      mode: this.mode,
      resumedFromStep: this.resumed ? this.step : null,
      ...(parentSessionId !== null ? { parentSessionId } : {}),
    });
    if (this.resumeStop !== null) {
      // the items decided before run() still reach the listeners (transcript.log is muted for a refused resume)
      this.flushDeferredAnnouncements();
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `resume refused: stored stopReason ${this.resumeStop} and its limit was not raised` });
      return this.finish(this.resumeStop, { skipWrite: true });
    }
    const session = this.opts.session;
    // TUI-DESIGN §15.2 main() row: the session fields, the sandbox level and the replan cap ride run:ready
    this.emit({
      type: 'run:ready',
      runId: this.runId,
      step: this.step,
      maxSteps: this.opts.limits.maxSteps,
      task: this.opts.task,
      resumed: this.resumed,
      sessionId: session?.sessionId ?? this.runId,
      parentRunId: session?.parentRunId ?? null,
      sandbox: this.sandbox.level,
      noNetwork: this.opts.noNetwork,
      maxReplans: this.opts.limits.maxReplans,
    });
    // contract 1.4 (W2b), §3.3 point 1 / §12.0.1 rule 5: the first beat and the identity patch. `setIdentity` is
    // AWAITED (once, before the first `coordinate`) rather than here, because its promise resolves only after every
    // newly reachable watch root has been walked, and blocking `run:ready` on a slow mount would be exactly the
    // "coordination delays a step" the design forbids.
    if (this.coord !== null) {
      const coord = this.coord;
      coord.start(this.heartbeatDynamic());
      this.coordReady = coord
        .setIdentity({ runId: this.runId, sessionId: this.opts.session?.sessionId ?? this.runId, ...(this.gitMeta.head !== null && this.gitMeta.head.kind === 'branch' ? { branch: this.gitMeta.head.name } : {}) })
        .catch(() => undefined);
      // contract 1.4 (W0 item 1, §3.2 / §9.3): the mint. The ledger minted this incarnation's claim when it opened;
      // `run.json` is where it survives the GC of every record it came from, so it is written here — once per
      // process, beside the heartbeat that announces the same epoch.
      this.persistClaimMint();
    }
    // TUI-DESIGN §12.2: the git banner and the instruction files as one event right after run:ready (notice-only, never a gate)
    this.emit({ type: 'workspace', git: this.gitMeta, instructions: (this.opts.instructions?.files ?? []).map((f) => ({ ...f })), sandbox: this.sandbox.level });
    for (const n of this.startupNotices) this.emit({ type: 'notice', step: null, kind: n.kind, level: n.level, text: n.text });
    // TUI-DESIGN §9.3: the clamp is an engine item so all three writers carry it
    if (session?.clamp) this.emit({ type: 'budget:clamp', runCapUsd: session.clamp.runCapUsd, clampedToUsd: session.clamp.clampedToUsd, sessionSpentUsd: session.clamp.sessionSpentUsd, sessionCapUsd: session.clamp.sessionCapUsd });
    // TUI-DESIGN §9.4: one budget:override per override the controller computed for THIS resume (EngineOptions.resumeOverrides);
    // they are appended to run.json.overrides[] below with the resumes[] entry — never re-derived from run.json
    const resumeOverrides = this.resumed ? (this.opts.resumeOverrides ?? []) : [];
    for (const o of resumeOverrides) {
      if (o.setting === 'decider.provider') {
        // TUI-DESIGN-2 §2.5 / §12: `[run] decider provider changed <from> → <to> (same weights: <openrouter id> ≡ <typesafe id>)` — a
        // config notice, not a budget item (run.json.overrides[] keeps the entry for --resume history)
        this.emit({ type: 'notice', step: null, kind: 'config', level: 'info', text: providerChangedText(o.from, o.to, this.resolvedJevModel ?? this.opts.deciderModel.configured) });
        continue;
      }
      this.emit({ type: 'budget:override', setting: o.setting, from: o.from, to: o.to, appliesTo: 'resume', source: o.source ?? 'flag' });
    }
    // TUI-DESIGN §8.3: the seeded line names the parent and what was carried. AGENT-LOOP-DESIGN §7.6: an agent run carries the
    // conversation (its transcript's `carry` record names the parent), and its seed's plan and window are empty — the line
    // read `plan done=0 remaining=0 unverified=0 · window 2 entries` between a `[you]` row and the reply, so it is not emitted
    if (this.seeded && this.opts.seed && this.mode !== 'agent') this.emit({ type: 'notice', step: null, kind: 'seeded', level: 'info', text: seedNoticeText(this.opts.seed, this.opts.seed.carriedDirectives ?? 0) });
    // §8.2 / review D8: the generator's window is smaller than the context floor — the run says so once, here
    if (this.pendingWindowNotice !== null) {
      this.emit({ type: 'notice', step: null, kind: 'ui', level: 'warn', label: '[ui]', text: this.pendingWindowNotice });
      this.pendingWindowNotice = null;
    }
    // TUI-DESIGN §10.2: the count of secrets the human sent on request (never the values)
    if (this.opts.secretsAcked !== undefined && this.opts.secretsAcked > 0) this.emit({ type: 'secret-ack', step: null, count: this.opts.secretsAcked });
    // TUI-DESIGN §8.6 / §15.2: steers, withdrawals, a pause and secret-acks decided before run(), in order, after every writer saw run:ready
    this.flushDeferredAnnouncements();
    this.runStartMono = this.clock();
    // contract 1.4 (W2b), §9.3: the resume gates, before the wall clock starts. `checkResumeClaim` is the only
    // AWAITED coordination read on the startup path, it runs on a resume only, and its failure is not a stop.
    await this.checkResumeClaim();
    this.checkFork();
    this.deadline = armWallDeadline(this.controller, this.opts.limits.maxWallMs - this.wallMsUsedBefore);
    if (this.resumed) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `resumed at step ${this.step + 1}` });
      // TUI-DESIGN §9.4: this resume's overrides are recorded in run.json together with its resumes[] entry
      this.persist(
        this.store.updateMeta({
          // contract 1.4 (§7.4): a --force resume of an ended run records `reopened` and clears run.json.ended (the run is live again)
          resumes: [{ resumedAt: nowIso(), previousStopReason: this.stopReason, ...(this.reopened ? { reopened: true as const } : {}) }],
          ...(resumeOverrides.length > 0 ? { overrides: resumeOverrides.map((o) => ({ ...o })) } : {}),
          // TUI-DESIGN-2 §2.5: the resolved id under the new provider's naming (see the constructor)
          ...(this.resolvedRekeyed ? { resolvedJevModel: this.resolvedJevModel } : {}),
          ...(this.reopened ? { ended: null } : {}),
        }),
        CHECKPOINT_FILES.meta,
      );
      if (this.reopened) this.emit({ type: 'transcript', step: null, level: 'info', text: `reopened: run ${this.runId} was ended; --force resumed it` });
      this.stopReason = null;
      // contract 1.4 (§7.3 step 3): the replay cache is read and gated once, before the first step
      if (this.replayRequested) await this.loadReplay();
    }
    // docs/AGENT-LOOP-DESIGN.md §2.2: the agent driver, once per run — the injected one, else `createAgentDriver()` (a dynamic import,
    // so the other modes never load `src/agent/`). A factory that throws (a ConfigError) ends the run here as a fatal error.
    if (this.mode === 'agent') this.agentDriverInstance = this.opts.agent ?? (await this.loadAgentFactory())();
    for (;;) {
      trace(`loop top step=${this.step} aborted=${this.signal.aborted}`);
      if (this.signal.aborted) {
        const cls = this.classifyStop();
        // contract 1.4 (§12.0.2 P5): a pause-now that cut the judge committed the step under rule 3; the point is the boundary
        if (cls.stop === 'human_pause') this.recordBoundaryPause();
        return this.finish(cls.stop);
      }
      const budget = checkBudgets(this.budgetInput());
      if (budget !== null) {
        this.emit({ type: 'transcript', step: null, level: 'info', text: `budget ${budget} reached at step start` });
        return this.finish(budget);
      }
      // contract 1.1 (TUI-DESIGN §9.1, §15.2): a requested pause ends the run only here, after the in-flight step committed whole
      if (this.pauseRequested) {
        // contract 1.4 (§12.0.2 P1 / P4): the boundary point
        this.recordBoundaryPause();
        return this.finish('human_pause');
      }
      // TUI-DESIGN §13.3: every blocking pause is awaited here — nothing is in flight and the last commit is whole
      if (this.blocked !== null) {
        const req = this.blocked;
        const answer = await this.awaitBlocker(req);
        if (this.signal.aborted) continue; // the abort is classified at the top
        // contract 1.4 (§12.0.2 P6, §11 row 37): pause() woke the pane → human_pause without adoptBlockedError (the pane's error is
        // not this stop's error). Two exceptions (review 2026-09-21 #25 / #26): `drift` keeps `[p] pin` / `[q] stop` only, so a
        // pause reads as `[q]` below; `checkpoint-degraded` exists because state.json failed, and finish()'s final write hits the
        // same disk — a pause there cannot end as exit 4, so it reads as `[r] retry the write` and the loop top pauses normally
        // once the write lands (a failing retry re-arms the pane and the run ends exit 3, not resumable).
        // `[t] worktree` (P7, §4.3 step 5) is the same resumable stop: the TUI creates the worktree and resumes with --replay
        if ((answer === 'pause' || answer === 'worktree') && req.kind !== 'drift' && req.kind !== 'checkpoint-degraded') {
          this.recordPanePause(req, answer === 'worktree' ? 'worktree' : 'pane');
          return this.finish('human_pause');
        }
        // TUI-DESIGN §13.3: the drift pane offers `[p] pin … for the next run` and `[q] stop` only — every answer ends the run with
        // exit 2 (a `retry` would re-run on the drifted model: the second call is no longer a first call)
        if (answer === 'stop' || req.kind === 'drift') {
          this.adoptBlockedError(req);
          return this.finish(req.stop);
        }
        // `[w] wait` (the lease-conflict pane, §4.3 step 4) is not a stop: the pane closes and the next step's coordinate
        // stage re-checks the lease — the wait belongs inside that stage, never to the loop top
        this.blocked = null;
        this.blockedError = null;
        if (req.kind === 'checkpoint-degraded') {
          // `[r] retry`, and `pause()` with it (contract 1.4, review #26): the write is tried again before the loop top pauses
          if (answer === 'continue') this.checkpointDegraded = true;
          else await this.retryStateWrite(req.step);
        }
        this.emitStatus();
        continue; // re-check abort, budgets and pause before the next step
      }
      // contract 1.4 (W2b), §9.3: the fork fence, at the boundary. `error` / exit 2, with the design's sentence.
      this.checkFork();
      if (this.forkStop !== null) {
        const e = new ConfigError(this.forkStop, { setting: 'coordination' });
        this.fatalSerialized = { ...serializeStopError(e, this.redact), exitCode: 2 };
        this.emit({ type: 'notice', step: null, kind: 'coordination', level: 'error', text: this.forkStop });
        return this.finish('error');
      }
      // contract 1.4 (W2b), §5.4: the inbox, at the step boundary — the one point where nothing is in flight, so a
      // `steer` lands as the next step's directive and a `pause` as this loop's next check. §5.4 gives the host the
      // same duty in all three modes; the engine doing it too is what makes `jevcode sessions pause <id>` against a
      // HEADLESS run apply at all, and the `seen` set plus `deliver`'s idempotency make the overlap harmless. The
      // `session:message` event carries `applied`, so a surface knows whether an ack is still owed.
      if (this.coord !== null) await this.coord.pumpInbox((msg, d) => this.applyIncoming(msg, d)).catch(() => undefined);
      this.applyPendingDirectives();
      const result = await this.runStep();
      trace(`runStep done step=${this.step} stop=${result.stop ?? 'null'}`);
      if (result.stop) return this.finish(result.stop, result.detail ? { detail: result.detail } : {});
    }
  }

  // -------------------------------------------------------------------------------------
  // TUI-DESIGN §8.6: the one plan mutation outside commit() — human directives at step start
  // -------------------------------------------------------------------------------------

  private applyPendingDirectives(): void {
    if (this.pendingDirectives.length === 0) return;
    const step = this.step + 1;
    // each ≤ 600, ≤ 8 of them → ≤ 4,800 chars; NEVER re-clipped as a batch (F7: max 8 × 600)
    const texts = this.pendingDirectives.map((d) => d.text);
    // seed / undo problems carry step 0 (§8.3) and are never superseded by a steer
    const isSteer = (h: HarnessProblem): boolean => h.kind === 'human' && h.step > 0;
    const superseded = this.plan.harnessProblems.filter((h) => isSteer(h) || h.kind === 'replan');
    // one problem per directive: ≤ 8 of the 16 PLAN_MAX_HARNESS_PROBLEMS slots; planJson clips per problem at 600 (state.ts);
    // the bound drops the oldest non-seed problems first, so the step-0 framing survives eight steers meeting eight other problems
    const added: HarnessProblem[] = texts.map((text) => ({ kind: 'human', text, step }));
    this.plan = { ...this.plan, harnessProblems: boundHarnessProblems([...this.plan.harnessProblems.filter((h) => !isSteer(h)), ...added], PLAN_MAX_HARNESS_PROBLEMS) };
    // reaches exactly this step's prompt hints, common state and SynthesisContext.directive; cleared at commit
    this.activeHuman = { texts, step };
    // counts and tripped cleared; trips history and replanCount kept
    this.detector.resetCounts();
    this.pendingDirectives = [];
    this.emit({ type: 'steer:applied', step, count: texts.length, superseded: superseded.map((h) => clip(h.text, 80)) });
    this.emitStatus();
  }

  // -------------------------------------------------------------------------------------
  // TUI-DESIGN §13.3: blocking pauses (one mechanism for every kind)
  // -------------------------------------------------------------------------------------

  private nextBlockingId(): string {
    this.blockingSeq += 1;
    return `${this.runId}:block:${this.blockingSeq}`;
  }

  /**
   * TUI-DESIGN §13.3: install the pause the loop top will await — the one place that allocates a blocking id and, for
   * `jev-unreachable`, advances the 30 s → 5 min backoff. A pane already up keeps its place (the later failure is dropped).
   */
  private installBlock(spec: BlockSpec, error: unknown): void {
    if (this.blocked !== null) return;
    const { autoRetry, ...request } = spec;
    let retryInMs: number | undefined;
    if (autoRetry === true) {
      this.unreachablePauses += 1;
      retryInMs = Math.min(JEV_UNREACHABLE_RETRY_MS * 2 ** (this.unreachablePauses - 1), JEV_UNREACHABLE_RETRY_MAX_MS);
    }
    this.blocked = { id: this.nextBlockingId(), ...request, ...(retryInMs !== undefined ? { retryInMs } : {}) };
    this.blockedError = error;
  }

  /**
   * Emit `blocking:request`, await the controller's answer raced against the auto-retry timer (`jev-unreachable` only;
   * the timer's wait is wakeable by retryNow()), emit `blocking:resolved`. No blocker (bench, --plain pipe, --no-input,
   * --json) → 'stop' at once. An engine abort while waiting → 'stop' too; the caller re-checks the signal.
   */
  private async awaitBlocker(req: BlockingRequest): Promise<BlockingAnswer> {
    this.emit({ type: 'blocking:request', request: req });
    this.emitStatus();
    const blocker = this.opts.blocker;
    let answer: BlockingAnswer = 'stop';
    let auto = false;
    if (blocker) {
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<{ answer: BlockingAnswer; auto: boolean }>((resolve) => {
        onAbort = (): void => resolve({ answer: 'stop', auto: false });
        if (this.signal.aborted) onAbort();
        else this.signal.addEventListener('abort', onAbort, { once: true });
      });
      // a blocker that throws (or rejects after the timer won) answers 'stop' and never surfaces as an unhandled rejection
      const answered = Promise.resolve()
        .then(() => blocker(req))
        .then((a) => ({ answer: a, auto: false }), () => ({ answer: 'stop' as const, auto: false }));
      const races: Promise<{ answer: BlockingAnswer; auto: boolean }>[] = [aborted, answered];
      const waker = req.kind === 'jev-unreachable' && req.retryInMs !== undefined ? new AbortController() : null;
      if (waker !== null && req.retryInMs !== undefined) {
        this.retryWaker = waker;
        races.push(sleep(req.retryInMs, undefined, waker.signal).then(() => ({ answer: 'retry' as const, auto: true })));
      }
      // contract 1.4 (COORDINATION-DESIGN §7.2, §12.0.2 P6): pause() aborts this controller so the awaited pane resolves 'pause'
      const blockWaker = new AbortController();
      this.blockWaker = blockWaker;
      races.push(
        new Promise<{ answer: BlockingAnswer; auto: boolean }>((resolve) => {
          const onPause = (): void => resolve({ answer: 'pause', auto: false });
          if (blockWaker.signal.aborted) onPause();
          else blockWaker.signal.addEventListener('abort', onPause, { once: true });
        }),
      );
      try {
        ({ answer, auto } = await Promise.race(races));
        // a `[r] now` press (retryNow aborted the waker) ended the wait early: a retry answered by the human, not by the timer
        if (auto && waker !== null && waker.signal.aborted) auto = false;
      } catch {
        answer = 'stop';
      } finally {
        if (onAbort !== null) this.signal.removeEventListener('abort', onAbort);
        if (this.blockWaker === blockWaker) this.blockWaker = null;
        if (waker !== null) {
          // the wait is over either way: release the waker so a later retryNow() reports false, and end the timer
          if (this.retryWaker === waker) this.retryWaker = null;
          waker.abort();
        }
      }
    }
    this.emit({ type: 'blocking:resolved', id: req.id, answer, auto });
    return answer;
  }

  /** TUI-DESIGN §13.3 `[q] stop`: the run ends with the request's stop reason and exit code; the failing error travels as the fatal error. */
  private adoptBlockedError(req: BlockingRequest): void {
    if (req.stop !== 'error' || this.fatalSerialized !== null) return;
    const e = this.blockedError;
    // a disk-class errno on the run dir is a checkpoint error (exit 3) whatever object the store threw
    const source = req.kind === 'checkpoint-degraded' && !isJevCodeError(e) ? new CheckpointError(`checkpoint degraded: ${req.detail}`, this.runDir, { cause: e }) : (e ?? new JevCodeError('internal', req.detail));
    const base = serializeStopError(source, this.redact);
    this.fatalSerialized = { ...base, exitCode: req.exitCode, ...(req.side ? { side: req.side } : {}) };
  }

  /** TUI-DESIGN §13.3 `[r] retry the write`: state.json again; success → `checkpoint:restored`, a disk-class failure re-blocks. */
  private async retryStateWrite(step: number): Promise<void> {
    try {
      await this.store.writeState(this.buildCheckpointState());
      this.emit({ type: 'notice', step, kind: 'checkpoint:restored', level: 'info', text: `checkpoint restored: ${CHECKPOINT_FILES.state} written` });
    } catch (e) {
      this.emit({ type: 'error', step, error: serializeError(e, this.redact), fatal: false });
      this.noteDiskError(e, CHECKPOINT_FILES.state, step);
    }
  }

  /**
   * TUI-DESIGN §13.3: a write failure of one of the six disk classes → `notice checkpoint:degraded` once per (file, code);
   * state.json → the checkpoint-degraded pause (exit 3). Returns false for anything that is not a disk-class error.
   */
  private noteDiskError(e: unknown, file: string | undefined, step: number | null): boolean {
    const disk = classifyDiskError(e, file);
    if (disk === null) return false;
    return this.noteDisk(disk, step, e);
  }

  /**
   * contract 1.7 item 8 (TUI-DESIGN-4 §7.2 P-D2 item 1): the same emit + block path, entered from a classification the
   * STORE made. The store reports every write path's failure through `attachDegradeListener`, which is what closes the
   * measured hole: `enqueue()` handles the tail of a chain whose caller never awaited it, so before round 4 a run whose
   * directory vanished mid-flight reported `complete`, exit 0, and the epilogue advertised a resume that could not work.
   * The once-per-`<file>:<code>` rule lives here, in `this.warned`, so the two entry points can never double-report.
   */
  private noteDisk(disk: DiskError, step: number | null, cause: unknown = null): boolean {
    if (!this.warned.has(disk.key)) {
      this.warned.add(disk.key);
      // contract 1.7 (TUI-DESIGN-4 §7.2 edge 6): the notice carries the whole SENTENCE — `checkpoint degraded:
      // EACCES on state.json — the run directory is not writable; this run cannot be resumed` — never the bare
      // `<code> on <file>` and never the raw `open '<path>'` suffix. `text` stays on `DiskError` for its captures.
      this.emit({ type: 'notice', step, kind: 'checkpoint:degraded', level: 'error', text: disk.sentence });
    }
    // `[c] continue without checkpoints` was chosen: later state.json failures stay notices, the run is already degraded;
    // a failure of the FINAL write (finish() in flight) has no loop top left to pause at — it makes the run exit 3 instead
    if (disk.file === CHECKPOINT_FILES.state && this.blocked === null && !this.checkpointDegraded && !this.finishing) {
      this.installBlock({ step: step ?? this.step, kind: 'checkpoint-degraded', detail: checkpointDegradedDetail(disk.code, disk.file), stop: 'error', exitCode: 3 }, cause);
      this.emitStatus();
    }
    return true;
  }

  /**
   * TUI-DESIGN §13.3: the blocking pause a failing stage asks for, or null when the failure keeps today's path.
   * 401/403 on either side → key-rejected (exit 2, first call or a key revoked mid-run alike); 402 or a spend-worded 429
   * → spend-limit (exit 5, no auto-retry); an exhausted Jev chain (network, 5xx, rate limit) → jev-unreachable, in session
   * mode only (a blocker exists) — without one the three failures → exit 5 of A165 stay.
   */
  private classifyBlocking(e: unknown, step: number): BlockSpec | null {
    // pure: no counter moves and no id is allocated until installBlock() — handleStepError may discard the result
    const http = e instanceof JevHttpError ? { side: 'jev' as const, err: e } : e instanceof ProviderHttpError ? { side: 'generator' as const, err: e } : null;
    if (http === null) return null;
    // docs/AGENT-LOOP-DESIGN.md §13.1 rule 3 / §14.3 item 7: Jev only routes in agent mode, so no Jev failure opens a pane there
    // (the placements fall back in code; one that escaped anyway is an ordinary stage failure)
    if (http.side === 'jev' && this.mode === 'agent') return null;
    const { side, err } = http;
    const message = this.redact(err.message);
    if (err.status === 401 || err.status === 403) {
      return { step, kind: 'key-rejected', side, detail: keyRejectedDetail(err.status, message), stop: 'error', exitCode: 2 };
    }
    if (err.status === 402 || (err.status === 429 && SPEND_LIMIT_RE.test(`${err.message}\n${err.body}`))) {
      return { step, kind: 'spend-limit', side, detail: clip(message, 200), stop: 'error', exitCode: 5 };
    }
    if (side === 'jev' && this.opts.blocker && (err.retryable || err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500)) {
      return { step, kind: 'jev-unreachable', side, detail: clip(message, 200), autoRetry: true, stop: 'error', exitCode: 5 };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------

  /** re-entrancy guard for `emit`: events raised by a listener while one is being delivered wait until that delivery completes */
  private emitting = false;
  private readonly emitQueue: EngineEvent[] = [];

  /**
   * Every sink — transcript.log (written first), the log, typed listeners, `onAny` listeners — sees the events in ONE order
   * (TUI-DESIGN §10 / §15.1 line identity). A listener that re-enters the engine while an event is being delivered (the TUI
   * or a test calling `steer()` / `annotate()` from `on('step:end')`) would otherwise have its events delivered to the
   * remaining listeners before they receive the event in flight, and transcript.log would disagree with the renderer's
   * stream as soon as that event yields a line (TUI-DESIGN-2 §4.5: `step:end` does). Nested emits are queued and drained
   * synchronously once the current dispatch finishes, so delivery stays synchronous and ordered.
   */
  private emit(e: EngineEvent): void {
    if (this.emitting) {
      this.emitQueue.push(e);
      return;
    }
    this.emitting = true;
    try {
      this.dispatch(e);
    } finally {
      // Drained even when the dispatch above threw: a nested event left in the queue would otherwise be delivered after the NEXT
      // unrelated event — the very reordering the queue exists to prevent.
      try {
        this.drainNested();
      } finally {
        this.emitting = false;
      }
    }
  }

  /**
   * Deliver the events queued by re-entrant listeners, in order. A nested dispatch that throws is contained the way it was when
   * the emit ran synchronously inside the listener (createEmitter's listener guard, core/events.ts): a warn transcript line
   * names it and the remaining queued events still go out in order.
   */
  private drainNested(): void {
    while (this.emitQueue.length > 0) {
      const next = this.emitQueue.shift()!;
      try {
        this.dispatch(next);
      } catch (err) {
        try {
          this.dispatch({ type: 'transcript', step: null, level: 'warn', text: `nested emit failed on ${next.type}: ${err instanceof Error ? this.redact(err.message) : String(err)}` });
        } catch {
          /* nothing left to report to */
        }
      }
    }
  }

  private dispatch(e: EngineEvent): void {
    const redacted = redactDeep(e, this.redact) as EngineEvent;
    this.recordTranscript(redacted);
    this.logEvent(redacted);
    this.events.emit(redacted);
  }

  /**
   * TUI-DESIGN §13.6: the engine's notice / warning / error lines reach `EngineOptions.log` (`<runDir>/jevcode.log` through
   * the controller) — every `notice` at its level, `transcript` lines at warn+, `error` events and a failed retry chain. The
   * event is already redacted; a throwing log never reaches the loop.
   */
  private logEvent(e: EngineEvent): void {
    const log = this.opts.log;
    if (log === undefined) return;
    try {
      switch (e.type) {
        case 'notice': {
          const line = `notice ${e.kind}${e.step !== null ? ` step=${e.step}` : ''}: ${e.text}`;
          if (e.level === 'error') log.error(line);
          else if (e.level === 'warn') log.warn(line);
          else log.info(line);
          return;
        }
        case 'transcript':
          if (e.level === 'error') log.error(`${e.step !== null ? `step=${e.step} ` : ''}${e.text}`);
          else if (e.level === 'warn') log.warn(`${e.step !== null ? `step=${e.step} ` : ''}${e.text}`);
          return;
        case 'error':
          log.error(`${e.fatal ? 'fatal ' : ''}error ${e.error.code}${e.step !== null ? ` step=${e.step}` : ''}: ${e.error.message}`);
          return;
        case 'retry:settled':
          if (!e.ok) log.warn(`${e.side} retry chain failed after ${e.attempts} attempts (${e.totalWaitMs} ms waited)${e.step !== null ? ` step=${e.step}` : ''}`);
          return;
        default:
          return;
      }
    } catch {
      /* a log failure is never the loop's problem (§13.6: log-write failures are swallowed) */
    }
  }

  /**
   * transcript.log gets one line per transcript item through the shared item model, numbered by
   * the engine's own counter from 0, so it agrees line for line with the plain renderer and the
   * TUI's <Static> pane (§10). Pane-only events (decision, status, deltas, ...) yield no line.
   */
  private recordTranscript(e: EngineEvent): void {
    if (this.transcriptMuted) return;
    const items = itemsFromEvent(e, this.transcriptSeq);
    if (items.length === 0) return;
    this.transcriptSeq += items.length;
    for (const item of items) this.persist(this.store.appendTranscript(formatTranscriptItem(item)), 'transcript');
  }

  private emitStatus(): void {
    // contract 1.4 (W2b), §3.3 point 4: a transition of phase / blocked / pausing / pauseNow / stage schedules ONE
    // coalesced beat (≤ 1 per 250 ms, the writer's own rule). Anything else is stored and rides the next beat, so
    // this is not a write per status event.
    this.coord?.set(this.heartbeatDynamic());
    this.emit({ type: 'status', status: this.status() });
  }

  private persist(p: Promise<void>, what: string): void {
    const tracked: Promise<void> = p
      .catch((e: unknown) => {
        const step = this.draft?.step ?? null;
        const ev: EngineEvent = { type: 'transcript', step, level: 'warn', text: `${what} write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` };
        // A transcript.log failure is reported to the renderers only; recording it would try the same file again.
        if (what === 'transcript') this.events.emit(redactDeep(ev, this.redact) as EngineEvent);
        else this.emit(ev);
        // TUI-DESIGN §13.3: ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE → `checkpoint degraded: <code> on <file>` once per (file, code)
        this.noteDiskError(e, what === 'transcript' ? CHECKPOINT_FILES.transcript : what, step);
      })
      .finally(() => {
        this.pendingPersists.delete(tracked);
      });
    this.pendingPersists.add(tracked);
  }

  private wallMsUsed(): number {
    return this.wallMsUsedBefore + (this.runStartMono === null ? 0 : Math.max(0, this.clock() - this.runStartMono));
  }

  private wallRemainingMs(): number {
    return Math.max(0, this.opts.limits.maxWallMs - this.wallMsUsed());
  }

  private budgetInput(only?: readonly BudgetKind[]): Parameters<typeof checkBudgets>[0] {
    const input: Parameters<typeof checkBudgets>[0] = {
      spendExceeded: this.opts.meter.exceeded(),
      // TUI-DESIGN §9.5: the token cap exists only under --allow-unpriced
      generatorTokens: this.generatorTokens,
      ...(this.opts.limits.maxGeneratorTokens !== undefined ? { maxGeneratorTokens: this.opts.limits.maxGeneratorTokens } : {}),
      wallMsUsed: this.wallMsUsed(),
      maxWallMs: this.opts.limits.maxWallMs,
      steps: this.step,
      maxSteps: this.opts.limits.maxSteps,
      replans: this.detector.replanCount(),
      maxReplans: this.opts.limits.maxReplans,
      replanPending: this.detector.tripped(),
    };
    if (only) input.only = only;
    return input;
  }

  private buildCheckpointState(): CheckpointState {
    const state: CheckpointState = {
      runId: this.runId,
      mode: this.mode,
      step: this.step,
      plan: this.plan,
      window: this.window,
      loopDetector: this.detector.toState(),
      spend: this.opts.meter.snapshot(),
      wallMsUsed: this.wallMsUsed(),
      timing: { ...this.timing },
      jevLatencyMs: [...this.jevLatencyMs],
      tokensPerStep: [...this.tokensPerStep],
      generatorTokensPerStep: [...this.generatorTokensPerStep],
      jevTokensPerStep: [...this.jevTokensPerStep],
      counters: { ...this.counters },
      directive: this.directive,
      lastTestRun: this.lastTestRun,
      lastChangeStep: this.lastChangeStep,
      createdThisRun: [...this.createdThisRun],
      resolvedJevModel: this.resolvedJevModel,
      jevModelDrift: this.jevModelDrift,
      stopReason: this.stopReason,
      interrupted: this.interrupted,
      // contract 1.4 (COORDINATION-DESIGN §7.2, §12.0.2): the replay detail rides only with its OWN `interrupted` — same step,
      // and the cache file it names is that step's, so a detail left by an earlier attempt is never written beside a later discard
      ...(this.interrupted !== null && this.interruptedDetail !== null && this.interruptedDetail.cache === stepCacheRel(this.interrupted.step)
        ? { interruptedDetail: { ...this.interruptedDetail, targetsSha: { ...this.interruptedDetail.targetsSha } } }
        : {}),
      ...(this.pausePoint !== null ? { pausePoint: { ...this.pausePoint } } : {}),
      consecutiveStageFailures: this.consecutiveStageFailures,
      jevQuestions: this.jevQuestions,
      ...(this.synthState !== null ? { synthState: this.synthState } : {}),
      // docs/AGENT-LOOP-DESIGN.md §10: the driver's state beside the synthesizer's; absent in every other mode
      ...(this.agentState !== null ? { agentState: this.agentState } : {}),
      // contract 1.1 (TUI-DESIGN §15 item 9): conditional spread, so an empty queue reads as absent (older readers unchanged)
      ...(this.pendingDirectives.length > 0 ? { pendingDirectives: this.pendingDirectives.map((d) => ({ ...d })) } : {}),
      ...(this.undoLog.length > 0 ? { undoLog: this.undoLog.map((u) => ({ ...u, restored: [...u.restored], skipped: u.skipped.map((k) => ({ ...k })) })) } : {}),
      ...(this.checkpointDegraded ? { checkpointDegraded: true } : {}),
      // contract 1.5 (ORCHESTRATION-DESIGN §4.1, §4.2 P9): the delegation this run is the parent of, and how many
      // splits it has spent. Both are conditional spreads, so a run that never delegated writes the same state.json
      // it wrote before this change — which is half of what M2 means by “zero cost”.
      ...(this.orchestration !== null ? { orchestration: { ...this.orchestration, agents: this.orchestration.agents.map((a) => ({ ...a })) } } : {}),
      ...(this.splits > 0 ? { splits: this.splits } : {}),
      // contract 1.4 (§12.0.3): the last prompt's chars, so a resumed process's context meter starts from a fact
      ...(this.lastPromptChars !== null ? { lastPromptChars: this.lastPromptChars } : {}),
      // docs/COORDINATION-DESIGN.md §8.3 / §8.4 / §12.0.3 (additive, conditional): absent while empty, so older readers and goldens are unchanged
      ...this.contextExtension(),
      // contract 1.9 (Fastlane) §8.1 (F25, the finishing pass): the same resolution `EngineStatus` reports, and
      // under the same absent-means-all-off rule — an ARCHIVED run directory can now be checked against
      // `summary.json.conditions[arm].mechanisms` without re-running it, and a control arm's state.json is
      // byte-identical to a pre-wave run's.
      ...this.mechanismsMember(),
      resumes: this.resumes,
      updatedAt: nowIso(),
    };
    if (this.stateError) state.error = this.stateError;
    this.lastSnapshot = state;
    return state;
  }

  private newDraft(step: number): StepDraft {
    return {
      step,
      startedAt: nowIso(),
      t0: this.clock(),
      intent: null,
      contextFiles: [],
      proposal: null,
      risk: null,
      riskSource: null,
      jevUnavailable: null,
      matchesIntent: null,
      outcome: null,
      output: '',
      changedFiles: [],
      tests: null,
      created: [],
      judge: null,
      completion: null,
      claims: [],
      claimsDropped: 0,
      claimProbabilities: null,
      decisions: [],
      jevRequests: [],
      generatorRecords: [],
      usage: { generator: zeroUsage(), jev: zeroUsage() },
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, confirmMs: 0, imagesMs: null, jevWallMs: 0, decomposeMs: 0, coordinateMs: 0, coordWaitMs: 0 },
      coord: null,
      synthMs: null,
      synthJevMs: 0,
      synthJevWallMs: 0,
      generatorBatch: { inFlight: 0, startedAt: 0 },
      closed: false,
      verify: { samples: 0, timeouts: 0, cancelled: 0, malformed: 0, reported: null, s2: { ttfbMs: [], hedges: 0, hedgeWins: 0, cacheRead: 0, cacheWrite: 0 } },
      proposer: null,
      fastPath: null,
      scopeUsable: null,
      fastPathMs: 0,
      fastPathJevMs: 0,
      generatorFailReason: null,
      errorClass: null,
      error: null,
      interruptedAt: null,
      jevStagesCompleted: 0,
      proposeCompleted: false,
      directive: null,
      notes: [],
      executeStarted: false,
      executeFinished: false,
      observed: true,
      patchTargets: [],
      lastError: null,
      partialText: '',
      partialChars: 0,
      llmRounds: 0,
      llmGoal: null,
      arrivedSamples: [],
      replayed: false,
      discarded: false,
      agent: null,
      agentGate: null,
      agentChanged: false,
    };
  }

  private async stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
    const step = this.draft?.step ?? this.step + 1;
    this.currentStage = name;
    stepTimeline.stage(name);
    const t0 = this.clock();
    this.emit({ type: 'stage:start', step, stage: name });
    // docs/AGENT-LOOP-DESIGN.md §9.1 (the TUI map): in agent mode the status names the stage that runs NOW, not the one that ended
    if (this.mode === 'agent') this.emitStatus();
    try {
      return await fn();
    } catch (e) {
      trace(`stage ${name} threw ${e instanceof Error ? e.name : typeof e}`);
      throw e;
    } finally {
      trace(`stage ${name} finally`);
      stepTimeline.stage('');
      this.emit({ type: 'stage:end', step, stage: name, ms: Math.max(0, this.clock() - t0) });
      this.emitStatus();
      trace(`stage ${name} end emitted`);
    }
  }

  private makeContext(draft: StepDraft, changedFiles: readonly string[]): StageContext {
    const self = this;
    return {
      runId: this.runId,
      step: draft.step,
      mode: this.mode,
      task: this.opts.task,
      limits: this.opts.limits,
      signal: this.signal,
      redact: this.redact,
      generation: this.opts.generation,
      workspace: this.workspace,
      sandbox: this.sandbox,
      workspaceInfo: this.wsInfo,
      changedFiles,
      createdThisRun: this.createdThisRun,
      get patchTargets(): readonly TargetInfo[] {
        return draft.patchTargets;
      },
      set patchTargets(v: readonly TargetInfo[]) {
        draft.patchTargets = [...v];
      },
      now: () => self.clock(),
      wallRemainingMs: () => self.wallRemainingMs(),
      emit: (e) => self.emit(e),
      ask: (stage, state, questions, annotate, signal) => self.ask(draft, stage, state, questions, annotate, signal),
      // contract 1.9 (Fastlane) §7.5 seam (b): spread in only when the caller pinned it, so a run that pins
      // nothing hands the stages exactly the object it handed them before the wave (I2)
      ...(this.opts.routers !== undefined ? { routers: this.opts.routers } : {}),
      ...(this.opts.contextAsk !== undefined ? { contextAsk: this.opts.contextAsk } : {}),
      generate: (req, attempt) => self.generateProposal(draft, req, attempt),
      noteMalformed: (attempt) => {
        const rec = draft.generatorRecords.find((r) => r.attempt === attempt);
        if (rec) rec.malformed = true;
      },
      startCandidateRefresh: () => {
        self.candidateRefresh = self.workspace.invalidateCandidates().catch((e: unknown) => {
          self.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `candidate refresh failed: ${e instanceof Error ? self.redact(e.message) : String(e)}` });
        });
      },
      // docs/COORDINATION-DESIGN.md §8.3 / §8.4: the zero-cost read and the `jevcode:outputs/` pseudo-path
      contextReads: this.contextReadHooks(),
      // ORCHESTRATION-DESIGN §2.5: spread in only when set, so a normal run's StageContext is unchanged
      ...(this.opts.orchestration !== undefined ? { orchestration: this.opts.orchestration } : {}),
    };
  }

  // -------------------------------------------------------------------------------------
  // Jev and generator calls (metered here, §6 Budgets)
  // -------------------------------------------------------------------------------------

  private async ask(draft: StepDraft, stage: StageName, state: Json, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void, signal?: AbortSignal): Promise<AskOutcome> {
    return (await this.askRecorded(draft, stage, state, questions, annotate, signal)).outcome;
  }

  /**
   * The one metered, recorded path to the decider; returns the raw AskResult too for the jev-only decider wrapper.
   *
   * contract 1.9 (Fastlane) §7.5 seam (a) — the **per-call signal**. A speculative router (§2.1 clause 6) aborts
   * the ask it dropped; before this seam that abort reached nobody, so the request ran to completion in here and
   * charged its metering, its `jev.jsonl` row, its `decision` events and its `draft` mutations to the step that
   * issued it — after that step's `StepRecord` had been written (review 2026-09-22, defect 2; I4). With the signal
   * threaded the request itself is cancelled, and a decider that ignores its signal and answers anyway is
   * **abandoned**: the call rejects at the guard below and nothing past `jevCache.ask` runs. Nothing is charged or
   * recorded for it beyond the router's own `dropped` row. `signal` is absent on every non-routed site, where
   * `this.signal` is the only signal and every line below is the pre-1.9 one.
   *
   * `quick` (docs/AGENT-LOOP-DESIGN.md §13.1 rules 3 and 6): the agent's routing asks — one attempt (`AskOptions.quick`), a
   * served-model mismatch that writes the warning and the `jevModelDrift` meta and then throws to the caller (never `fatalError`,
   * never a drift pane), and unpriced usage that is announced but never stops the run. Absent everywhere else.
   */
  private async askRecorded(draft: StepDraft, stage: StageName, state: Json, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void, signal?: AbortSignal, quick = false): Promise<{ outcome: AskOutcome; res: AskResult }> {
    assertQuestionBatch(questions);
    trace(`engine.ask ${stage} step=${draft.step} start`);
    let res: AskResult;
    const retry = this.retryHooks('jev', draft.step, stage);
    // HARNESS-NEXT-DESIGN §4.4: `jevWaitMs` per stage — per router once §3.x labels its asks
    const endJevWait = stepTimeline.span('jev', stage);
    // §7.5 seam (a): the run signal and the caller's, as one. `linkedAbort` is the same helper the router and the
    // sample channel use, and its `unlink` runs in the finally so a run-scoped signal collects no listeners.
    const link = signal === undefined ? null : linkedAbort(this.signal);
    let onCallAbort: (() => void) | null = null;
    if (link !== null && signal !== undefined) {
      if (signal.aborted) link.controller.abort(signal.reason);
      else {
        onCallAbort = (): void => link.controller.abort(signal.reason);
        signal.addEventListener('abort', onCallAbort, { once: true });
      }
    }
    // and the same wall as a plain number, always: `harnessMs` is derived from it so an in-process decider that
    // reports `latencyMs: 0` cannot charge its own CPU to the gated harness budget (see StepDraft.timing)
    const askT0 = this.clock();
    try {
      res = await this.jevCache.ask(state, questions, { signal: link?.controller.signal ?? this.signal, stage, step: draft.step, onRetry: retry.onRetry, wake: retry.wake, ...(quick ? { quick: true as const } : {}) });
      retry.settled(true);
    } catch (e) {
      retry.settled(false);
      trace(`engine.ask ${stage} rejected ${e instanceof Error ? e.name : typeof e}`);
      throw e;
    } finally {
      if (onCallAbort !== null && signal !== undefined) signal.removeEventListener('abort', onCallAbort);
      link?.unlink();
      // §7.5 seam (a): an abandoned ask charges no wall either — the step it would charge may already be committed,
      // and the router's own `heldMs` is where that wall is accounted (I3).
      if (signal?.aborted !== true) draft.timing.jevWallMs += Math.max(0, this.clock() - askT0);
      endJevWait();
    }
    // §7.5 seam (a): the decider answered a call nobody is waiting on any more (it ignored its signal, or it
    // resolved in the same tick the router dropped it). NOTHING below runs: no meter, no `jev.jsonl` row, no
    // `decision` event, no `draft` mutation. The router already recorded the drop; this is the write I4 forbids.
    // The reason the CALLER gave (routeSpeculative names the router and the drop) travels on, so the router's own
    // `isRouterFatal` sees a plain Error and keeps its single silent drop branch — never the harness's own stop.
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error(`ask ${stage} (step ${draft.step}) was abandoned by its caller after the answer arrived`);
    trace(`engine.ask ${stage} resolved attempts=${res.attempts}`);
    // TUI-DESIGN §13.2: a reachable Jev restarts the unreachable backoff (30 s again on the next pause)
    this.unreachablePauses = 0;
    this.opts.meter.add('jev', res.usage);
    this.noteUsage('jev', res.model, draft.step, stage, res.usage, quick);
    // TUI-DESIGN §9.5: noteUsage read the raw (possibly NaN) cost; the record, the step draft and the sum take the clamped copy
    const usage = pricedUsage(res.usage);
    addUsage(draft.usage.jev, usage);
    draft.timing.jevMs += res.latencyMs;
    const ids = Object.keys(questions);
    // TUI-DESIGN-2 §2.4 / §6 item 6: the client's cost basis rides the record (jev.jsonl) and the run-level aggregate (`/jev`, costBlock)
    // review finding 8: a hit is MARKED, never inferred from `usage.calls === 0` — the bench's
    // stub decider reports 0 calls on every request, so the inference counted every stubbed
    // request as a cache hit
    const record: JevRequestRecord = { step: draft.step, stage, requestHash: res.requestHash, latencyMs: res.latencyMs, questions: ids.length, usage, model: res.model, attempts: res.attempts, ...(res.costBasis !== undefined ? { costBasis: res.costBasis } : {}), ...(res.cached === true ? { cached: true } : {}) };
    if (res.costBasis !== undefined) this.jevBasisCounts[res.costBasis] += 1;
    draft.jevRequests.push(record);
    this.jevLatencyMs.push(res.latencyMs);
    this.emit({ type: 'jev:request', record });
    this.persist(this.store.appendJevRequest(record), 'jev.jsonl');
    const firstCall = this.jevCalls === 0;
    this.jevCalls += 1;
    const served = this.checkModelDrift(res.model, firstCall, draft.step, quick);
    const rows: Decision[] = [];
    for (const id of ids) {
      const q = questions[id]!;
      const a = res.answers[id];
      if (!a) throw new JevResponseError(`missing answer for question "${id}"`, { path: `answers.${id}`, transient: false });
      if (a.type !== q.type) throw new JevResponseError(`answer type ${a.type} does not match question type ${q.type} for "${id}"`, { path: `answers.${id}.type`, transient: false });
      const row: Decision = {
        step: draft.step,
        stage,
        id,
        question: q,
        answer: a,
        probability: decisionProbability(a, q),
        confidence: decisionConfidence(a, q),
        latencyMs: res.latencyMs,
        requestHash: res.requestHash,
      };
      if (served !== null) row.servedModel = served;
      rows.push(row);
    }
    annotate?.(res.answers, rows);
    draft.decisions.push(...rows);
    for (const r of rows) this.emit({ type: 'decision', decision: r });
    this.persist(this.store.appendDecisions(rows), 'decisions.jsonl');
    draft.jevStagesCompleted += 1;
    return { outcome: { answers: res.answers, rows, latencyMs: res.latencyMs }, res };
  }

  /**
   * TUI-DESIGN §13.2 / §15 item 5: the `onRetry` / `wake` pair handed to one decider or provider call. `onRetry` creates a
   * fresh waker before every sleep (an AbortController aborts once) and emits `retry`; `wake` is the getter the clients
   * read per attempt; `settled` (call it in the finally of the call) emits `retry:settled` when a retry happened and
   * nulls the waker so a later retryNow() reports false.
   *
   * contract 1.9 (Fastlane) §7.5 seam (e) — **keyed per in-flight request** (review defect 6 of the engine set).
   * The shown slots (`retryWaker`, `retrying`) used to be written and, worse, CLEARED by whichever call touched
   * them last. Routers make two jev asks overlap for the first time: a router ask the step abandoned settles
   * while the next step's ask is sleeping between attempts, and the abandoned one's `settled()` nulls the live
   * call's waker (so `[r]` reports "no retry sleep is active" and the sleep runs to its end) and clears the
   * `retrying` status the TUI is showing. Each call now holds its own waker in a local and only writes or clears
   * the shared slot while it OWNS it — last writer shows, and only that writer may take the display down.
   */
  private retryHooks(side: 'jev' | 'generator', step: number, stage: StageName, sample?: number): { onRetry: (info: RetryInfo) => void; wake: () => AbortSignal | undefined; settled: (ok: boolean) => void } {
    let retries = 0;
    let totalWaitMs = 0;
    // docs/LLM-JEV-DESIGN.md §4.8: wakers are keyed per sample; the status line (`retrying`) shows sample 0's — or the one-sample call's
    const shown = sample === undefined || sample === 0;
    const key = sample ?? 0;
    // §7.5 seam (e): THIS call's waker. `wake()` reads it, never the shared slot, so a concurrent call's
    // controller is never handed to this client's sleep.
    let own: AbortController | null = null;
    return {
      onRetry: (info) => {
        retries += 1;
        totalWaitMs += Math.max(0, info.waitMs);
        // §7.5 seam (e): a fresh controller per sleep, held here AND published — last writer shows
        own = new AbortController();
        if (shown) this.retryWaker = own;
        else this.sampleWakers.set(key, own);
        if (shown) this.retrying = { side, attempt: info.attempt, maxAttempts: info.maxAttempts, untilMs: Date.now() + Math.max(0, info.waitMs) };
        this.emit({ type: 'retry', side, step, stage, info });
        this.emitStatus();
      },
      wake: () => (shown ? own : this.sampleWakers.get(key))?.signal,
      settled: (ok) => {
        // §7.5 seam (e): a call that never slept owns nothing and clears nothing — that is the whole defect. A
        // call that did only takes the display down while the slot is still the controller IT published.
        const mine = own;
        own = null;
        if (mine !== null) {
          if (shown) {
            if (this.retryWaker === mine) {
              this.retryWaker = null;
              this.retrying = null;
            }
          } else if (this.sampleWakers.get(key) === mine) this.sampleWakers.delete(key);
        }
        if (retries === 0) return;
        this.emit({ type: 'retry:settled', side, step, attempts: retries + 1, ok, totalWaitMs });
        this.emitStatus();
      },
    };
  }

  /**
   * After every meter.add (TUI-DESIGN §9.2, §9.5): the 50/80/95 % warnings for the run (own snapshot) and the session
   * (`snapshot.parent`), and the unpriced-usage notice when the provider reported no finite cost.
   */
  private noteUsage(side: SpendSource, model: string, step: number, stage: StageName, usage: TokenUsage, quick = false): void {
    if (!Number.isFinite(usage.costUsd)) {
      // TUI-DESIGN §9.5 (A135–A137): unknown pricing fails closed — the step commits, then the run stops with error unless
      // --allow-unpriced; the item is announced once per (side, model) per run, not once per metered call
      const key = `${side}:${model}`;
      if (!this.unpricedAnnounced.has(key)) {
        this.unpricedAnnounced.add(key);
        this.emit({ type: 'budget:unpriced', side, model, step, tokens: { input: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0, output: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0 } });
      }
      // docs/AGENT-LOOP-DESIGN.md §13.1 rule 3: an agent routing ask's unpriced usage is the announcement above, never the stop
      if (this.opts.allowUnpriced !== true && this.unpriced === null && !quick) this.unpriced = { side, model, stage };
    }
    this.emitBudgetWarn(step);
  }

  /** TUI-DESIGN §9.2: once per (scope, pct) per run, the highest only when one add crosses two, `restored` after a resume, never for +Infinity. */
  private emitBudgetWarn(step: number): void {
    const snap = this.opts.meter.snapshot();
    const run = nextBudgetWarn(snap.totalUsd, snap.capUsd, this.announcedRun, this.restoredSpentUsd !== undefined ? { restoredSpentUsd: this.restoredSpentUsd } : {});
    this.announcedRun = run.announced;
    if (run.warn !== null) {
      const rate = this.perStepRate(snap.totalUsd);
      this.emit({
        type: 'budget:warn',
        scope: 'run',
        pct: run.warn.pct,
        spentUsd: snap.totalUsd,
        capUsd: snap.capUsd,
        step,
        stepsLeftEstimate: stepsLeftEstimate(snap.totalUsd, snap.capUsd, rate),
        restored: run.warn.restored,
        ...(rate !== null ? { perStepUsd: rate } : {}),
        ...(snap.jev.costUsd > snap.generator.costUsd ? { jevShare: { jevUsd: snap.jev.costUsd, generatorUsd: snap.generator.costUsd } } : {}),
      });
    }
    const parent = snap.parent;
    if (parent) {
      const session = nextBudgetWarn(parent.totalUsd, parent.capUsd, this.announcedSession);
      this.announcedSession = session.announced;
      if (session.warn !== null) {
        this.emit({ type: 'budget:warn', scope: 'session', pct: session.warn.pct, spentUsd: parent.totalUsd, capUsd: parent.capUsd, step, stepsLeftEstimate: null, restored: false });
      }
    }
  }

  /** TUI-DESIGN §9.2: the p50 cost of the steps committed in this process; the run's mean per step right after a resume; null before any step. */
  private perStepRate(totalUsd: number): number | null {
    if (this.costPerStep.length > 0) {
      const sorted = [...this.costPerStep].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const p50 = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      return p50 > 0 ? p50 : null;
    }
    if (this.step > 0 && totalUsd > 0) return totalUsd / this.step;
    return null;
  }

  /**
   * jev-only (docs/JEV-ONLY.md): what the Synthesizer sees for one step. `emit` is the engine's
   * redacting emit (so `synth` lines reach transcript.log and the renderers); `ask` and
   * `decider.ask` both go through askRecorded (metered, jev.jsonl, decisions.jsonl, the pane,
   * the REPORT question rules), so a synthesizer cannot spend Jev budget or take a decision the
   * run does not record. The signal is the engine's; a synthesizer's own signal is ignored.
   */
  /** The workspace listing, in the `listing` timing bucket (HARNESS-NEXT-DESIGN §4.4); a failed listing is an empty one, as before. */
  private async listCandidatesTimed(): Promise<Awaited<ReturnType<Workspace['listCandidates']>>> {
    const end = stepTimeline.span('listing', 'candidates');
    try {
      return await this.workspace.listCandidates();
    } catch {
      return [];
    } finally {
      end();
    }
  }

  /**
   * docs/LLM-JEV-DESIGN.md §9.4: whether the synthesizer covers this workspace, decided once per run from the workspace listing
   * (the layout does not change under the run); a synthesizer without `handles` covers everything.
   */
  private async synthesizerHandles(synthesizer: Synthesizer): Promise<boolean> {
    if (this.synthHandles !== null) return this.synthHandles;
    if (synthesizer.handles === undefined) return (this.synthHandles = true);
    const listing = await this.listCandidatesTimed();
    const handles = synthesizer.handles(this.wsInfo, listing.map((c) => c.path));
    if (!handles) {
      // once per run (the answer is cached in `synthHandles`; a resume re-derives it once more): the `[setup]` notice the
      // renderer shows at run start, so a TypeScript workspace under the default mode is told plainly that the synthesizer
      // covers Python workspaces with a detected test runner and this run takes the generic per-step propose
      this.emit({ type: 'notice', step: null, kind: 'config', level: 'info', label: '[setup]', text: `synthesizer ${synthesizer.name} covers Python workspaces with a detected test runner; this workspace takes the generic per-step propose (docs/LLM-JEV-DESIGN.md §9.4)` });
      this.emit({ type: 'transcript', step: this.step + 1, level: 'info', text: `synthesizer ${synthesizer.name} does not cover this workspace; proposing through the generic per-step fallback (docs/LLM-JEV-DESIGN.md §9.4)` });
    }
    return (this.synthHandles = handles);
  }

  /**
   * contract 1.9 (Fastlane) docs/LLM-LOOP-DESIGN.md §4 (route R9), stage 1: may ONE bounded sieve round run for a
   * single-file failing cluster on this step, and with what budget? `null` is the decline — the record is already on
   * the draft — and then the LLM proposes as usual and nothing else about the step changes.
   *
   * The whole route is a BRANCH: the code default (the generator's `propose_action`) is what runs when it declines,
   * and it declines for free on every step whose predicate does not hold. This half runs OUTSIDE any stage precisely
   * because it must cost nothing and emit nothing; `fastPathRound` is the half that is a propose stage. It never
   * applies anything (I7): an accepted proposal goes through the unchanged risk → confirm → coordinate → budget →
   * execute → judge path.
   */
  private async fastPathArm(draft: StepDraft): Promise<ArmedFastPath | null> {
    if (this.fastPathOption !== 'auto' || this.mode !== 'jev-on') return null;
    const runner = this.fastPathRunner ?? (this.fastPathRunner = new FastPathRunner());
    // §4.6: the engine's 4-entry window reaches the round's memory on EVERY step of an armed run, not only on rounds —
    // otherwise `lastEngineRun` / `lastChangeStep` go stale and the ledger claims a commit the workspace never took.
    runner.observe(this.runId, this.window);
    const state = runner.state(this.runId);
    const run = this.lastTestRun;
    const tRunMs = run?.durationMs ?? 0;
    // §6 row 14: snapshotted here, where the predicate reads it, because this step's own run replaces it at commit
    draft.scopeUsable = this.lastTestRunScopeUsable;
    const decline = (reason: FastPathReason): null => {
      draft.fastPath = declinedRecord(reason, tRunMs, state.disarmed);
      return null;
    };
    // stage 1a — free: engine state only, no workspace listing, no Jev, no LLM, no test run
    const free = fastPathStage1Free({
      mode: this.mode,
      option: this.fastPathOption,
      lastTestRun: run,
      lastRunWasTestCommand: run !== null && isTestCommand(run.command, this.wsInfo.testCommand),
      scopeUsable: this.lastTestRunScopeUsable,
      lastChangeStep: this.lastChangeStep,
      spendLeftUsd: Math.max(0, this.opts.limits.spendCapUsd - this.opts.meter.snapshot().totalUsd),
      disarmed: state.disarmed,
      loopTripped: this.detector.tripped(),
      pausePending: this.pauseRequested,
      // §4.5 / I8: with the warm plane on, a warm-screened passer is indistinguishable from a cold-confirmed one in
      // the evidence the facade can see, so the route refuses to enter rather than record a coldness it cannot check
      warmEnabled: warmPlaneEnabled(),
    });
    if (free !== null) return decline(free);
    // stage 1b: the listing behind T2 / T6 / T8, paid for only now
    const listing = (await this.listCandidatesTimed()).map((c) => c.path);
    if (this.fastPathHandles === null) this.fastPathHandles = synthesizerHandles(this.wsInfo, listing);
    // §4.4: the share is taken of the RUN's remaining wall (there is no per-step wall limit in `Limits`), and it is
    // additionally bounded by what the run-wide fast-path ledger has left, so the AGGREGATE over rounds is bounded too.
    // `fullSuiteMs` is passed only when the loop's own run really was the full suite — the unscoped detected command.
    const fullSuiteMs = this.wsInfo.testCommand !== null && run !== null && run.command.trim() === this.wsInfo.testCommand.command.trim() ? tRunMs : undefined;
    const budget = fastPathBudget({
      tRunMs,
      ...(fullSuiteMs === undefined ? {} : { fullSuiteMs }),
      wallRemainingMs: this.wallRemainingMs(),
      runWallLeftMs: Math.max(0, fastPathRunWallCapMs(this.opts.limits.maxWallMs) - state.wallSpentMs),
    });
    const suspects = fastPathSuspects(this.lastTestRunOutput, listing, this.opts.task);
    // T10: the `(file, failing-test-id-set)` key the design names, parsed out of the run's own output. The counts are
    // the FALLBACK, used only when the output named no test: two different clusters with the same counts must not
    // collide (the first would make the second read as `fingerprint_seen` and a winnable round would never be entered).
    const failingIds = fastPathFailingIds(run?.command ?? '', this.lastTestRunOutput);
    const fingerprint = fastPathFingerprint(suspects[0] ?? '', failingIds.length > 0 ? failingIds : [`${run?.command ?? ''}#${run?.failed ?? 0}/${run?.errors ?? 0}`]);
    const gate = fastPathStage1Workspace({
      handles: this.fastPathHandles,
      suspects,
      repository: isRepositoryWorkspace(this.wsInfo.testCommand, listing),
      layoutDetected: detectLayout(listing) !== 'other',
      // §6 row 9: the round edits nothing in the workspace, but a patch that cannot land is not worth the wall. This
      // is the COORDINATION ledger's own verdict on the implicated file (the same `check()` the coordinate stage
      // runs), not this run's dirty-file list: a peer's exclusive lease is the thing that stops a patch landing, and
      // a file this run itself modified earlier is not a lease conflict and must not be counted as one in §8.
      leaseConflict: suspects.length === 1 && this.coord !== null && this.coord.conflictOn([suspects[0] ?? ''], draft.step),
      wallLeftMs: this.wallRemainingMs(),
      budget,
      fingerprint,
      state,
    });
    if (!gate.fire) return decline(gate.reason);
    if (budget === null) return decline('no_wall');
    this.emit({ type: 'synth', step: draft.step, phase: 'fastpath:considered', detail: `${gate.file}: ${run?.failed ?? 0} failing, ${run?.errors ?? 0} errors at t_run ${tRunMs} ms` });
    state.attempts.set(fingerprint, (state.attempts.get(fingerprint) ?? 0) + 1);
    return { runner, state, budget, fingerprint, tRunMs };
  }

  /**
   * The round itself, run INSIDE `this.stage('propose', …)` by the call site — the round is a propose, and a propose
   * is a stage: one `stage:start` / `stage:end` pair, `currentStage` on `'propose'` for its whole length, a
   * `stepTimeline` span and an `emitStatus()` at its end. A round may last `wallMs + reserveMs + graceMs` (up to ~47 s
   * with the default cap), so a round outside the stage left every consumer that pairs the two events — the TUI's
   * stage display, the timing derivation, the bench event parser — reading an unmatched sequence for that long.
   *
   * `draft.fastPathMs` stays the FACADE's own clock diff (§4.4 bound 3), not the stage's wall.
   */
  private async fastPathRound(draft: StepDraft, armed: ArmedFastPath): Promise<Proposal | null> {
    const { runner, state, budget, fingerprint, tRunMs } = armed;
    const result = await runner.run(this.synthesisContext(draft, []), budget);
    draft.fastPathMs = result.telemetry.wallMs;
    draft.fastPathJevMs = result.telemetry.jevMs;
    draft.fastPath = firedRecord(result, { tRunMs, budget, disarmed: state.disarmed });
    if (result.kind !== 'proposed') {
      // T10: the cluster is not tried again this run — `mem.tried` is monotone, so a second round would enumerate nothing
      state.seen.add(fingerprint);
      return null;
    }
    return result.proposal;
  }

  /**
   * contract 1.4 (W3), COORDINATION-DESIGN §6 / W3 item 28: `SynthesisContext.coordination`, built once per run.
   *
   * `CoordinationRuntime.subworkEnded(kind, id)` needs the kind; the synthesizer's seam takes the id alone (a producer
   * that must repeat its own kind to close a row gets it wrong eventually). The adapter is therefore the one thing
   * that remembers the pairing, in a map bounded by the runtime's own `SUBWORK_MAX`: a row the runtime dropped for
   * the cap is still closed here, and the map cannot outgrow what the heartbeat carries.
   */
  private synthSubwork(): SynthSubwork {
    const existing = this.subworkAdapter;
    if (existing !== null) return existing;
    const kinds = new Map<string, SubworkEntry['kind']>();
    const adapter: SynthSubwork = {
      subworkStarted: (entry) => {
        if (this.coord === null) return;
        if (!kinds.has(entry.id) && kinds.size >= SUBWORK_MAX) return;
        kinds.set(entry.id, entry.kind);
        this.coord.subworkStarted(entry.kind, entry.id, entry.stage, entry.detail, entry.laneDir);
      },
      subworkEnded: (id) => {
        const kind = kinds.get(id);
        if (kind === undefined) return;
        kinds.delete(id);
        this.coord?.subworkEnded(kind, id);
      },
    };
    this.subworkAdapter = adapter;
    return adapter;
  }

  private synthesisContext(draft: StepDraft, contextFiles: readonly FileView[], contextText?: string): SynthesisContext {
    const self = this;
    const decider: Decider = {
      model: this.opts.decider.model,
      provider: this.opts.decider.provider, // contract 1.2 (TUI-DESIGN-2 §6 item 7)
      ask: async (state, questions, o) => (await self.askRecorded(draft, o.stage, state, questions)).res,
    };
    return {
      runId: this.runId,
      step: draft.step,
      task: this.opts.task,
      plan: this.plan,
      window: this.window,
      intent: draft.intent?.intent ?? INTENT_FALLBACK,
      contextFiles,
      // contract 1.4 (COORDINATION-DESIGN §8.8 column 3): the relaxed view for a synthesizer that prompts the
      // generator itself. ABSENT — not empty — when this run builds none (`jev-only`, `view: 'legacy'`), so the
      // synthesizer's own prompt is byte-identical to what it built before this landed.
      ...(contextText === undefined || contextText.length === 0 ? {} : { contextText }),
      workspace: this.workspace,
      workspaceInfo: this.wsInfo,
      sandbox: this.sandbox,
      decider,
      signal: this.signal,
      limits: this.opts.limits,
      redact: this.redact,
      emit: (e) => self.emit(e),
      ask: (stage, state, questions) => self.ask(draft, stage, state, questions),
      createdThisRun: this.createdThisRun,
      // TUI-DESIGN §8.6 / §15.3: the human texts join Jev's directive with a blank line and no batch clip (parseDirective only scans for a move name)
      directive: [draft.directive?.text, ...(this.activeHuman?.step === draft.step ? this.activeHuman.texts : [])].filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n\n') || null,
      runDir: this.store.dir,
      synthState: this.synthState,
      setSynthState: (state) => {
        // Bounded and redacted before it can reach a checkpoint (docs/JEV-ONLY-DESIGN.md §5.2).
        if (state === null) {
          self.synthState = null;
          return;
        }
        const text = JSON.stringify(redactDeep(state, self.redact));
        self.synthState = text.length <= SYNTH_STATE_MAX_BYTES ? (JSON.parse(text) as Json) : null;
        if (text.length > SYNTH_STATE_MAX_BYTES) self.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `synth state dropped: ${text.length} bytes exceeds ${SYNTH_STATE_MAX_BYTES}` });
      },
      // docs/LLM-JEV-DESIGN.md §4.8: the sanctioned generator channel — metered, recorded per sample, events carry the sample
      // index; absent in jev-only, where the propose stage never reaches the LLM (generate() throws there in any case).
      // The synthesizer's LLM source is built once per run and keeps the FIRST step's function (search/llm.ts runOf): the
      // step a sample belongs to is the step it is dispatched in, so the draft is resolved at call time — the engine's
      // current draft, or this step's when none is open — never bound to the context that handed the function out.
      // contract 1.4 (W3), §6 / W3 item 28: the heartbeat's sub-work rows. One adapter per run, so an `ended` finds the
      // `kind` its `started` used; absent when coordination is off, which is the whole of "zero cost when absent".
      ...(this.coord === null ? {} : { coordination: this.synthSubwork() }),
      ...(this.mode === 'jev-only' ? {} : { generate: (req: GenerateRequest, o: SampleOptions) => self.generate(self.draft ?? draft, req, 1, o) }),
      // F04 (finishing pass): the RECORDING channel is not the LLM channel, and gating them together made
      // `JEVCODE_WARM=on --mode jev-only` the very silent no-op `warmPlaneFor`'s `unsupported-runner` /
      // `unsupported-command` rows exist to kill — the synthesizer called `ctx.reportVerify?.(…)` on `undefined`
      // and the step recorded nothing. It costs nothing when nobody calls it (`draft.verify.reported` stays null
      // and `StepRecord.verify` stays absent), so it is installed in every mode; `generate` above stays gated,
      // because jev-only has no generating LLM and must never acquire one.
      reportVerify: (counts: Partial<StepVerifySummary>) => {
        const d = self.draft ?? draft;
        d.verify.reported = { ...(d.verify.reported ?? {}), ...counts };
      },
    };
  }

  // -------------------------------------------------------------------------------------
  // docs/AGENT-LOOP-DESIGN.md §2.2 (slice S4): the agent seam — what the driver sees and what it may write
  // -------------------------------------------------------------------------------------

  /**
   * §2.2, §15 S4 item 8: what the driver sees for one step — the twin of `synthesisContext`. Every generator and Jev call goes
   * through the engine's metered, recorded paths (`generate` with the agent hooks, `askRecorded` quick at stage `loop`); the driver's
   * state rides the checkpoint; steers and a `/compact` are handed over once.
   */
  private agentContext(draft: StepDraft): AgentContext {
    const self = this;
    const orchestration = this.opts.orchestration;
    return {
      runId: this.runId,
      runDir: this.runDir,
      sessionId: this.opts.session?.sessionId ?? this.runId,
      step: draft.step,
      task: this.opts.task,
      resumed: this.resumed,
      workspace: this.workspace,
      workspaceInfo: this.wsInfo,
      sandbox: this.sandbox,
      limits: this.opts.limits,
      signal: this.signal,
      redact: this.redact,
      autonomy: this.opts.autonomy ?? 'full',
      verify: this.opts.agentVerify ?? 'off',
      provider: { name: this.opts.provider.name, model: this.opts.provider.model },
      generation: this.opts.generation,
      // §7.1: the window the engine's own policy resolves (an explicit `contextPolicy.windowTokens`, else the pricing table's)
      windowTokens: this.opts.contextPolicy?.windowTokens ?? this.opts.generatorPricing?.contextTokens ?? null,
      // §7.4: the `llm` writer is the agent's default only while `context.compaction` is the default layer's
      compaction: { mode: this.opts.contextPolicy?.compaction ?? DEFAULT_CONTEXT_COMPACTION, explicit: settingIsExplicit(this.opts.configRecord, 'context.compaction') },
      instructions: nonEmptyText(this.opts.instructions?.text),
      memoryIndex: nonEmptyText(this.opts.memory?.index),
      seed: this.opts.seed ?? null,
      conversation: this.opts.conversation ?? null,
      ...(orchestration !== undefined ? { orchestration } : {}),
      plan: this.plan,
      lastTestRun: this.lastTestRun,
      testsCurrent: testsCurrent(this.lastTestRun, this.lastChangeStep),
      createdThisRun: this.createdThisRun,
      dirtyAtStart: this.dirtyAtStart,
      // §14.2: the session's decider is the absent one when no Jev key resolved — no placement asks, no wait is spent
      jevAvailable: this.opts.decider.model !== ABSENT_DECIDER_MODEL,
      state: this.agentState,
      setState: (state) => self.setAgentState(state, draft.step),
      emit: (e) => self.emit(e),
      // the step a turn belongs to is the step it is issued in (the engine's current draft), like the synthesizer's samples
      // §A1: the fresh git probe is adopted before the turn's calls are resolved (it ran beside the model's latency)
      generate: async (req, hooks) => {
        const result = await self.generate(self.draft ?? draft, req, hooks.turn, undefined, undefined, hooks);
        await self.adoptGitRefresh();
        return result;
      },
      ask: async (state, questions, signal) => (await self.askRecorded(self.draft ?? draft, 'loop', state, questions, undefined, signal, true)).outcome,
      routeToken: () => stepTokenFor(self.runId, draft.step),
      writeOutput: (text, part) => self.writeAgentOutput(draft.step, text, part),
      takeSteers: () => self.takeAgentSteers(draft.step),
      takeCompactRequest: () => {
        const asked = self.agentCompactRequested;
        self.agentCompactRequested = false;
        return asked;
      },
      reportContext: (usage) => {
        self.agentContextUsage = usage;
      },
      // wall-clock ms: the driver stamps transcript records (`at`) and `lastCompactionAt` with it — the engine's own clock is
      // monotonic (`performance.now()`), which printed 1970-01-01T00:00:07Z timestamps in the S6 live transcripts. An
      // injected clock (tests) is used as is.
      now: () => (self.opts.now ?? Date.now)(),
      wallRemainingMs: () => self.wallRemainingMs(),
    };
  }

  /**
   * AGENT-LOOP-DESIGN §A1 latency: a run that started from the caller's cached git probe adopts the background re-probe once,
   * after its first model turn and before any tool call is resolved (nothing has run yet): the dirty set that decides
   * `git_discard`, `cleanAtStart` and the `run` pre-images is the workspace as it is now, never as it was at the last probe.
   */
  private async adoptGitRefresh(): Promise<void> {
    const pending = this.gitRefresh;
    if (pending === null) return;
    this.gitRefresh = null;
    const fresh = await pending;
    // a repository that appeared or went away since the cached probe is left as the run started (the next run probes it)
    if (fresh === null || !fresh.repo || this.gitState === null || !this.gitState.repo) return;
    this.gitState = fresh;
    this.dirtyAtStart.clear();
    for (const p of dirtyPathsOf(fresh)) this.dirtyAtStart.add(p);
    this.workspace.adoptGitState?.(fresh);
    // run.json's start facts follow when the tree moved since the cached probe (HEAD or the dirty counts)
    const meta = runGitMetaOf(fresh);
    if (JSON.stringify([meta.head, meta.dirtyAtStart]) !== JSON.stringify([this.gitMeta.head, this.gitMeta.dirtyAtStart])) this.persist(this.store.updateMeta({ git: meta }), CHECKPOINT_FILES.meta);
  }

  /** §2.2: the driver's factory, by a dynamic import — so `src/agent/` is loaded only by an agent run without an injected driver. */
  private async loadAgentFactory(): Promise<AgentDriverFactory> {
    const mod: { createAgentDriver: AgentDriverFactory } = await import('../agent/index.js');
    return mod.createAgentDriver;
  }

  /** §10: bounded and redacted before it can reach a checkpoint, like the synthesizer's; an oversize state keeps the last good one. */
  private setAgentState(state: Json, step: number): void {
    const text = JSON.stringify(redactDeep(state, this.redact));
    const bytes = text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
    if (text === undefined || bytes > AGENT_STATE_MAX_BYTES) {
      if (!this.agentStateOversizeWarned) {
        this.agentStateOversizeWarned = true;
        this.emit({ type: 'transcript', step, level: 'warn', text: `agent state not checkpointed: ${bytes} bytes exceeds ${AGENT_STATE_MAX_BYTES}; the checkpoint keeps the previous state` });
      }
      return;
    }
    this.agentState = JSON.parse(text) as Json;
  }

  /**
   * §7.2: a spilled tool output — `outputs/step-<n>.txt` through the store (its redaction and per-run bound), or one of several
   * parts `step-<n>-<k>.txt` of an observe step. The `jevcode:` pointer the result names, or null when the write failed.
   */
  private async writeAgentOutput(step: number, text: string, part?: number): Promise<string | null> {
    try {
      if (isOutputPart(part)) {
        const ref = await writeOutputPart(this.runDir, step, part, text, this.redact, this.outputParts);
        if (ref === null && !this.outputPartsFullNoted) {
          this.outputPartsFullNoted = true;
          this.emit({ type: 'transcript', step, level: 'warn', text: `outputs: spilled parts reached the run's ${Math.round(AGENT_OUTPUT_PARTS_MAX_BYTES / (1024 * 1024))} MB bound; later results keep their inline head and tail only` });
        }
        return ref;
      }
      if (!hasContextStore(this.store)) return null;
      await this.store.writeOutput(step, text);
      return `${OUTPUT_READ_PREFIX}${outputRefFor(step)}`;
    } catch (e) {
      this.emit({ type: 'transcript', step, level: 'warn', text: `agent output write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
      this.noteDiskError(e, CHECKPOINT_FILES.outputs, step);
      return null;
    }
  }

  /** §10 Steer: this step's applied steers, handed to the driver once — a discarded attempt of the same step gets none again. */
  private takeAgentSteers(step: number): readonly string[] {
    const active = this.activeHuman;
    if (active === null || active.step !== step || active === this.agentSteersTaken) return [];
    this.agentSteersTaken = active;
    return [...active.texts];
  }

  /**
   * §12 / §A2: the classifier's gate on an `act` step's call. `block` refuses (the rule `RiskAssessment`, a `risk` event, outcome
   * `blocked`); `review` asks through the existing confirm path — reachable only under `--autonomy review` or in a depth-1 child,
   * which answers from its parent (a review under full autonomy elsewhere is approved and logged, as today); `ok` runs, and a
   * rule-matched `ok` (a destructive command under full autonomy) keeps its rule on the step and is noted after it ran.
   */
  private async applyAgentGate(draft: StepDraft, proposal: Proposal, gate: AgentGate): Promise<void> {
    const step = draft.step;
    draft.agentGate = gate;
    if (gate.verdict === 'ok' && gate.rule === null) return;
    const risk = ruleRiskAssessment(gate);
    draft.risk = risk;
    if (gate.verdict === 'ok') return;
    if (gate.verdict === 'block') {
      this.emit({ type: 'risk', step, risk });
      draft.outcome = { status: 'blocked', reason: gate.reason };
      this.counters.blocked += 1;
      this.emit({ type: 'outcome', step, outcome: draft.outcome });
      return;
    }
    if ((this.opts.autonomy ?? 'full') === 'full' && this.opts.orchestration?.depth !== 1) {
      this.counters.reviews += 1;
      draft.notes.push(`review auto-approved (autonomy: full): ${gate.reason}`);
      this.emit({ type: 'transcript', step, level: 'info', text: `review · auto-approved (autonomy: full) · ${gate.reason}` });
      return;
    }
    this.emit({ type: 'risk', step, risk });
    const outcome = await this.confirm(draft, proposal, risk);
    // counted once the review resolved, like the legacy review (an abort while it is pending discards the step)
    this.counters.reviews += 1;
    if (outcome.note !== undefined) draft.notes.push(`reviewer note: ${outcome.note}`);
    if (!outcome.approved) {
      const identity = this.opts.confirmer.identity;
      const base = identity === 'reviewer' ? `declined by reviewer: ${gate.reason}` : `not approved (${identity}): ${gate.reason}`;
      draft.outcome = { status: 'declined', reason: outcome.note !== undefined ? `${base} — reviewer note: ${outcome.note}` : base };
      this.counters.declined += 1;
      this.emit({ type: 'outcome', step, outcome: draft.outcome });
    }
  }

  /**
   * §3.4 / §A5: a command's post image also covers the dirty-set files it changed — the run-start dirty files `changedFiles()`
   * never reports — so `/undo` restores them and the per-step change set sees them. Computed once, before the post images.
   */
  private async agentPostFiles(draft: StepDraft, images: AgentImages, changed: readonly string[]): Promise<readonly string[]> {
    try {
      images.preChanged = await changedSincePre({ root: this.workspace.root, runDir: this.runDir, step: draft.step, pre: images.pre });
    } catch (e) {
      this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `pre-image comparison failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
      images.preChanged = null;
      return changed;
    }
    const extra = images.preChanged.filter((p) => !changed.includes(p));
    return extra.length === 0 ? changed : [...changed, ...extra];
  }

  /**
   * §2.2 / §3.4: after the step's execute tail and BEFORE the checkpoint — the destructive note of a rule-matched command that ran,
   * the per-step change set, the driver's `observe()` (wrapped: a throw is a transcript warning and a stage failure, and the step
   * still commits), the code judge of a test run, the step's agent summary, and the change fact `lastChangeStep` reads at commit.
   */
  private async observeAgentStep(draft: StepDraft, next: AgentNext, actx: AgentContext, before: readonly string[], images: AgentImages | null): Promise<void> {
    const step = draft.step;
    const action = next.proposal.action;
    const post = this.lastPostImage !== null && this.lastPostImage.step === step ? this.lastPostImage : null;
    let changed: string[];
    try {
      changed = await stepChangeSet({ action, outcome: draft.outcome, before, after: draft.changedFiles, pre: images?.pre ?? null, preChanged: images?.preChanged ?? null, post, root: this.workspace.root, runDir: this.runDir, step });
    } catch (e) {
      // unknown counts as changed: the run-cumulative set is the conservative answer (it can only make a test run stale)
      changed = action.kind === 'run' ? [...draft.changedFiles] : [];
      this.emit({ type: 'transcript', step, level: 'warn', text: `per-step change set unavailable: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
    }
    const gate = draft.agentGate;
    // §A5: the note says `ran`, so it is written only for a command whose process ran (a cwd that does not exist fails before spawn)
    const ran = draft.outcome?.status === 'executed' || draft.outcome?.status === 'interrupted';
    if (draft.executeStarted && ran && gate !== null && gate.rule !== null && action.kind === 'run') this.noteDestructive(draft, action.command, gate.rules ?? [gate.rule], images, post, changed);
    // §3.4 / §A5: a command's outcome lists the workspace's changed files, which misses what it put BACK — a file `git reset --hard`
    // returned to HEAD, an untracked file `git clean` removed. The per-step change set (pre- and post-images) has them, and the
    // step record carries them, so `/undo` finds the step: the S6 live `/undo` after a discard answered "the last run changed no files"
    if (action.kind === 'run' && draft.outcome?.status === 'executed') {
      const listed = new Set(draft.outcome.changedFiles);
      const missed = changed.filter((p) => !listed.has(p));
      if (missed.length > 0) draft.outcome = { ...draft.outcome, changedFiles: [...draft.outcome.changedFiles, ...missed] };
    }
    const outcome: ActionOutcome = draft.outcome ?? { status: 'failed', error: draft.error !== null ? `${draft.error.stage}: ${draft.error.code}` : 'no outcome' };
    const observation: AgentObservation = { step, outcome, output: draft.output, changedFiles: changed, tests: draft.tests, error: draft.error !== null ? { code: draft.error.code, message: draft.error.message } : null };
    const { loopTrip: plannedTrip, ...summary } = next.summary;
    let seqAfter = summary.seqAfter;
    let loopTrip: LoopTrip | null = plannedTrip ?? null;
    try {
      const r = await this.agentDriverOrThrow().observe(actx, observation);
      seqAfter = r.seqAfter;
      loopTrip = r.loopTrip;
    } catch (e) {
      const err = toJevCodeError(e);
      this.emit({ type: 'transcript', step, level: 'warn', text: `agent observe failed: ${this.redact(err.message)} — the step commits without a confirmed tool result` });
      this.emit({ type: 'error', step, error: serializeError(e, this.redact), fatal: false });
      this.lastStageError = e;
      this.lastErrorStage = 'propose';
      // §8: a stage failure (three in a row stop the run with `error`); one that already failed at a stage counts once
      if (draft.error === null) {
        draft.error = { stage: 'propose', code: err.code, message: this.redact(err.message) };
        this.consecutiveStageFailures += 1;
      }
    }
    if (draft.tests !== null) {
      const exec = draft.outcome?.status === 'executed' || draft.outcome?.status === 'interrupted' ? draft.outcome.exec : undefined;
      draft.judge = codeJudge({ tests: draft.tests, exitCode: exec?.exitCode ?? null, evidence: null, testsPassUnparsed: null }, draft.claims, ledgerGoalsOf(draft.claims));
    }
    draft.agent = { ...summary, seqAfter, ...(loopTrip !== null ? { loopTrip } : {}) };
    // §2.2: a command other than the detected test command that changed a workspace file makes every earlier test run stale
    if (action.kind === 'run' && draft.tests === null && changed.length > 0) draft.agentChanged = true;
  }

  /** §A2 / §A5: one truthful line for a destructive command that ran — what left the machine, and what `/undo` can restore. */
  private noteDestructive(draft: StepDraft, command: string, rules: readonly string[], images: AgentImages | null, post: PostImage | null, changed: readonly string[]): void {
    const nothingDirty = images !== null && images.pre === null && images.dirty === 0;
    const preWhole = nothingDirty || (images !== null && images.pre !== null && images.pre.skipped.length === 0);
    const postWhole = post === null ? nothingDirty && changed.length === 0 : !post.hashSkipped && post.skipped.length === 0;
    const headAfter = post?.headOid ?? headOidOf(this.workspace.gitState?.() ?? this.gitState);
    const coverage = destructiveCoverage({ rule: rules[0] ?? '', rules, command, imagesComplete: preWhole && postWhole, headMoved: images === null || images.headBefore !== headAfter });
    const exec = draft.outcome?.status === 'executed' || draft.outcome?.status === 'interrupted' ? draft.outcome.exec : undefined;
    const text = destructiveNote(command, rules, coverage, exec?.exitCode ?? null);
    draft.notes.push(text);
    // the note is written from what actually ran, so it is the one reason the record keeps (a driver's pre-execution reason may disagree)
    if (draft.risk !== null) draft.risk = { ...draft.risk, reason: text };
    this.emit({ type: 'transcript', step: draft.step, level: 'warn', text });
  }

  private agentDriverOrThrow(): AgentDriver {
    if (this.agentDriverInstance === null) throw new JevCodeError('internal', 'agent mode: the driver was not loaded');
    return this.agentDriverInstance;
  }

  /** §3.3 / §8: the agent `complete` — a current, green run of the unscoped detected test command (the plan is not consulted). */
  private agentVerifiedCompletion(): boolean {
    return isUnscopedGreenRun(this.lastTestRun, this.wsInfo.testCommand) && testsCurrent(this.lastTestRun, this.lastChangeStep);
  }

  /**
   * §5.4 rule 7. Returns the served id when it must be recorded on the rows, else null. TUI-DESIGN-2 §2.5 / §6 item 8: the
   * first call matches under the provider's naming through `jevModelMatches` (`jev-latest` → `jev-1.13.0` on TypeSafe,
   * `jev-1.13` → `jev-1.13-20260917` on OpenRouter; a bare prefix no longer lets `jev-1.1` accept `jev-1.13-…`); `provider`
   * defaults to openrouter so bench/cli.ts and perf/step-overhead.ts build the options untouched.
   */
  private checkModelDrift(servedRaw: string, firstCall: boolean, step: number, quick = false): string | null {
    const { configured, pinned } = this.opts.deciderModel;
    const provider = this.opts.deciderModel.provider ?? 'openrouter';
    const cfg = normaliseModelId(configured);
    const served = normaliseModelId(servedRaw);
    let ok: boolean;
    let rekey = false;
    if (this.resolvedJevModel !== null) {
      ok = served === normaliseModelId(this.resolvedJevModel);
      // TUI-DESIGN-2 §2.5: the same weights under the other naming (EQUIVALENT_IDS — a cross-provider --resume, or a router renaming the
      // id) are not drift; the resolved id follows the served naming from here on, so later calls compare equal
      if (!ok && sameJevWeights(this.resolvedJevModel, servedRaw)) {
        ok = true;
        rekey = true;
      }
    } else if (pinned) ok = served === cfg;
    else ok = jevModelMatches(configured, servedRaw, provider);
    if (ok) {
      if (this.resolvedJevModel === null) {
        this.resolvedJevModel = servedRaw;
        this.persist(this.store.updateMeta({ resolvedJevModel: servedRaw }), 'run.json');
        if (!this.opts.deciderModel.pinned) {
          this.emit({ type: 'transcript', step, level: 'warn', text: `jev model alias ${this.opts.deciderModel.configured} resolved to ${servedRaw}; pin it with --jev-model ${servedRaw} for reproducible thresholds` });
        }
      } else if (rekey || (this.resolvedRekeyed && this.resolvedJevModel !== servedRaw)) {
        // the re-keyed table id gives way to the id actually served (verbatim, like a first call's)
        this.resolvedJevModel = servedRaw;
        this.resolvedRekeyed = false;
        this.persist(this.store.updateMeta({ resolvedJevModel: servedRaw }), 'run.json');
      }
      return null;
    }
    const err = new JevModelDriftError(this.opts.deciderModel.configured, servedRaw, { firstCall });
    if (quick) {
      // docs/AGENT-LOOP-DESIGN.md §13.1 rule 3: an agent routing ask is never fatal — the warning and the `jevModelDrift` meta as
      // for a later call, then the error goes to the caller (the placement's wrapper records it and stops asking Jev for the run).
      // No `fatalError`, no `stageBlock`, first call or not: a one-shot run keeps going and a session opens no drift pane.
      if (this.jevModelDrift === null) {
        this.jevModelDrift = { step, served: servedRaw };
        this.persist(this.store.updateMeta({ jevModelDrift: this.jevModelDrift }), 'run.json');
      }
      if (!this.driftWarned) {
        this.driftWarned = true;
        this.emit({ type: 'transcript', step, level: 'warn', text: this.redact(err.message) });
      }
      throw err;
    }
    if (firstCall) {
      if (this.opts.blocker) {
        // TUI-DESIGN §13.3: in session mode the first-call drift is a blocking pane (`[p] pin … for the next run  [q] stop (exit 2)`), not an abort
        this.stageBlock = { request: { step, kind: 'drift', side: 'jev', detail: driftDetail(this.opts.deciderModel.configured, servedRaw), stop: 'error', exitCode: 2 }, error: err };
        throw err;
      }
      // First call of the run: abort with the ConfigError exit code (§5.4 rule 7).
      this.fatalError = err;
      if (!this.controller.signal.aborted) this.controller.abort(new AbortError('error'));
      throw err;
    }
    if (this.jevModelDrift === null) {
      this.jevModelDrift = { step, served: servedRaw };
      this.persist(this.store.updateMeta({ jevModelDrift: this.jevModelDrift }), 'run.json');
    }
    if (!this.driftWarned) {
      this.driftWarned = true;
      this.emit({ type: 'transcript', step, level: 'warn', text: this.redact(err.message) });
    }
    return servedRaw;
  }

  /**
   * contract 1.9 (Fastlane) §3.1 (F25): the run's TTFB p50, `null` until there is enough of it to act on.
   *
   * The `LLM_DEADLINE_ADAPT.minSamples` floor is the synthesizer's own rule and it is here for the same reason
   * (review defect 8): one fast first byte is not evidence about a run, and acting on it would pin the §3.2
   * threshold at its 3 s floor for the rest of the run from a single observation.
   */
  private p50TtfbMs(): number | null {
    return this.ttfbMsAll.length >= LLM_DEADLINE_ADAPT.minSamples ? percentile(this.ttfbMsAll, 50) : null;
  }

  /** §3.1: one propose leg's time to first byte — the run's p50, and this step's `StepRecord.verify.ttfbMs`. */
  private noteProposeFirstByte(draft: StepDraft, ms: number): void {
    if (!(Number.isFinite(ms) && ms >= 0)) return;
    if (this.ttfbMsAll.length < TTFB_READINGS_MAX) this.ttfbMsAll.push(ms);
    if (draft.verify.s2.ttfbMs.length < TTFB_READINGS_MAX) draft.verify.s2.ttfbMs.push(ms);
  }

  /**
   * contract 1.9 (Fastlane) §3.1–§3.3 (F25): the propose stage's call, with the S2 generation path on it.
   *
   * With the switch off this is `generate` and nothing else — the same one call, the same options object, byte for
   * byte what `jev-on` has always sent. With it on the call becomes a §3.2 race: the origin goes out at once, and if
   * it has produced NO FIRST BYTE for `hedgeAfterMs(this run's TTFB p50)` one twin follows it on the ROTATED upstream
   * order. The first leg with a result wins, the other is cancelled and booked, and the counters land on
   * `StepRecord.verify` so the §8.3 S2 row is a measurement rather than an intention.
   *
   * The decision half — the threshold, the twin index, the rotation — is `src/jev-modes/synth/llm/hedge.ts`, the same module
   * the synthesizer's round uses. What is NOT shared is the round's scheduling: the dollar hold, `samplesLeft` and
   * the arrival ledger have no meaning for one call.
   */
  private async generateProposal(draft: StepDraft, req: GenerateRequest, attempt: number): Promise<GenerateResult> {
    if (this.s2 === 'off') return this.generate(draft, req, attempt);
    const t0 = this.clock();
    const out = await hedgedCall<GenerateResult>({
      signal: this.signal,
      // `'partial'` is the measurement half without the hedge: `JEVCODE_HEDGE=off` said so explicitly
      hedge: this.s2 === 'on',
      p50TtfbMs: () => this.p50TtfbMs(),
      onHedge: (text) => this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `hedge: ${text}` }),
      run: (leg) =>
        this.generate(draft, leg.twin ? twinRequest(req) : req, attempt, undefined, {
          signal: leg.signal,
          onFirstByte: (ms) => {
            this.noteProposeFirstByte(draft, ms);
            leg.onFirstByte(ms);
          },
          ...(leg.twin ? { sample: leg.sample } : {}),
        }),
    });
    draft.verify.s2.hedges += out.hedges;
    draft.verify.s2.hedgeWins += out.hedgeWins;
    // Review defect A2: the RACE's wall, exactly as `noteSampleEnd` takes the batch wall for a round — not the
    // winner's provider-reported latency alone. On a twin win the twin's own `latencyMs` starts at the hedge
    // threshold, so booking only it left the origin's whole 3–8 s wait in NO named bucket, and the residual
    // formula at the commit charged all of it to `harnessMs` — the harness-overhead metric the 50 ms p95 budget
    // is read against. The loser's latency stays on its own cancelled row and is never added here (that would
    // double-count one wall as two). `max` of the two so a clock that cannot see the wait still books the call.
    draft.timing.generatorMs += Math.max(out.result.latencyMs, Math.max(0, this.clock() - t0));
    return out.result;
  }

  /**
   * The one metered, recorded path to the generating LLM. Without `sample` it is the propose stage's call (jev-on, jev-off:
   * one attempt, the engine's signal). With `sample` (llm-jev, docs/LLM-JEV-DESIGN.md §4.8) it is one sample of the
   * synthesizer's round: the sample's signal is linked to the engine's, every event and the generator.jsonl row carry the
   * sample index, a sample aborted (or failed after streaming) before its result is metered from an estimate
   * (`recordUnfinishedSample`) and rejects with the signal's reason, a sample already cancelled when it arrives is never
   * dispatched (no event, no row, no metering), and `timing.generatorMs` takes the wall of the round, not the sum of the samples.
   *
   * `hooks` (docs/AGENT-LOOP-DESIGN.md §9.3): an agent turn. `generator:delta` is emitted exactly as always (unless `silent`, the
   * compaction writer) and each chunk also goes to `onText`; a retry of the chain calls `onAttemptReset` with the attempt that
   * starts; reasoning becomes throttled `generator:reasoning`; `generator:tool-delta` names the call being written. `attempt` is
   * the turn number. Every legacy call site passes none, and its options, events and rows are the pre-agent ones byte for byte.
   */
  private async generate(draft: StepDraft, req: GenerateRequest, attempt: number, sample?: SampleOptions, leg?: OneShotLeg, hooks?: AgentGenerateHooks): Promise<GenerateResult> {
    // Defence in depth for docs/JEV-ONLY.md: even with a real provider in the slot, jev-only never reaches it.
    if (this.mode === 'jev-only') throw new ConfigError('jev-only mode: the generating LLM must not be called', { setting: 'mode' });
    // §4.8: a sample cancelled before it reached the channel (a loser cancellation racing a stagger fire, or the engine
    // stopping) was never served — reject with the reason before any event, row or metered token
    if (sample !== undefined && sample.signal.aborted) throw sample.signal.reason;
    if (sample !== undefined && this.signal.aborted) throw this.signal.reason;
    // contract 1.4 (§12.0.2 P3): the round the pause cache names comes from the synthesizer's own sample options, never from
    // the free-text `synth` event; the samples of one batch carry the same pair, so the last one dispatched is the round
    if (sample?.goalId !== undefined) draft.llmGoal = { goalId: sample.goalId, round: sample.goalRound ?? Math.max(0, draft.llmRounds - 1) };
    // contract 1.9 (Fastlane) §3.2 (F25): a hedge TWIN of the one-shot propose call carries its twin index on every
    // event and on its `generator.jsonl` row, which is how `hedgeOriginOf` reads it back. The ORIGIN keeps the shape
    // it has always had (no `sample`), so an unhedged jev-on step's rows are byte-identical to HEAD's.
    const at = sample === undefined ? (leg?.sample === undefined ? {} : { sample: leg.sample }) : { sample: sample.sample };
    if (sample !== undefined) {
      // contract 1.4 (COORDINATION-DESIGN §6.4, §7.3 step 3, P3): a sample that arrived before the pause is served from the round
      // cache — no provider call, no metering, no row (nothing was bought); the events say so for the renderers
      const cached = this.takeCachedSample(draft, req, sample);
      if (cached !== null) {
        this.emit({ type: 'generator:start', step: draft.step, attempt, ...at });
        this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `sample ${sample.sample} replayed from ${stepCacheRel(draft.step)} (no generator call)` });
        this.emit({ type: 'generator:end', step: draft.step, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, latencyMs: 0, finishReason: 'replayed', ...at });
        return cached;
      }
    }
    this.emit({ type: 'generator:start', step: draft.step, attempt, ...at });
    // Tool-call argument fragments are reported as a cumulative character count per call; the
    // renderer coalesces ("streaming action… N chars", §7/§10). The text itself is parsed once at the end.
    let toolChars = 0;
    let textChars = 0;
    const retry = this.retryHooks('generator', draft.step, 'propose', sample?.sample);
    const link = sample === undefined ? null : this.linkSample(sample);
    // docs/AGENT-LOOP-DESIGN.md §9.3: the per-turn state of the agent's tool-call and reasoning callbacks (null on legacy calls)
    const tap = hooks === undefined ? null : createAgentStreamTap({ step: draft.step, turn: hooks.turn, now: () => this.clock(), emit: (e) => this.emit(e), ...(hooks.onToolCall !== undefined ? { onToolCall: hooks.onToolCall } : {}) });
    const t0 = this.clock();
    if (sample !== undefined) this.noteSampleStart(draft, sample.sample);
    // §4.8: the provider's facts on a sample that yields no result — the ids and streamed sizes of an aborted stream, its usage
    // frame when it had arrived, or a rate-limited end (`CancelledGeneration.rateLimited`); null when the callback never fired
    const held: { partial: CancelledGeneration | null } = { partial: null };
    let res: GenerateResult;
    // HARNESS-NEXT-DESIGN §4.1 queue 2: the sample wait, per sample; the bucket's `ms` is the union, so a round of
    // eight concurrent samples reports the round's exposed wall and `sumMs` the summed time
    const endSampleWait = stepTimeline.span('sample', sample === undefined ? 'one-shot' : `sample${sample.sample}`);
    try {
      res = await this.opts.provider.generate(req, {
        signal: link?.signal ?? leg?.signal ?? this.signal,
        ...at,
        onDelta: (text) => {
          textChars += text.length;
          this.notePartial(draft, text, sample === undefined);
          if (hooks?.silent !== true) this.emit({ type: 'generator:delta', step: draft.step, text, ...at });
          hooks?.onText?.(text);
        },
        onToolDelta: (fragment) => {
          toolChars += fragment.length;
          this.notePartial(draft, fragment, sample === undefined);
          this.emit({ type: 'generator:tool-delta', step: draft.step, chars: toolChars, ...at, ...(tap?.toolFields() ?? {}) });
        },
        onRetry: hooks?.onAttemptReset === undefined ? retry.onRetry : (info: RetryInfo) => {
          retry.onRetry(info);
          // §9.3: bytes of the failed attempt may have streamed — the shaper drops its pending text and says the reply restarted
          hooks.onAttemptReset?.(info.attempt + 1);
        },
        wake: retry.wake,
        ...(tap !== null ? { onToolCall: (d: ToolCallDelta) => tap.toolCall(d), onReasoning: (fragment: string) => tap.reasoning(fragment) } : {}),
        ...(sample !== undefined
          ? {
              // contract 1.9 (Fastlane) §3.1: the engine keeps the facts for the row AND hands them to the synthesizer's
              // own callback when it asked for one — the sample's accounting is the synthesizer's, the row is the engine's.
              onCancelled: (partial: CancelledGeneration) => {
                held.partial = partial;
                sample.onCancelled?.(partial);
              },
            }
          : hooks !== undefined
            ? // docs/AGENT-LOOP-DESIGN.md §15 S4 item 7: an agent turn keeps the provider's facts of a cut stream for its row too
              {
                onCancelled: (partial: CancelledGeneration) => {
                  held.partial = partial;
                },
              }
            : {}),
        // contract 1.9 (Fastlane) §3.1: time to first byte, forwarded verbatim. It is the §3.2 hedge's only input, so the
        // channel must not swallow it; absent when the caller asked for none, which is a one-shot propose call and every
        // sample of a synthesizer that does not measure TTFB.
        ...(sample?.onFirstByte === undefined ? (leg?.onFirstByte === undefined ? {} : { onFirstByte: leg.onFirstByte }) : { onFirstByte: sample.onFirstByte }),
      });
      retry.settled(true);
      tap?.flush();
    } catch (e) {
      retry.settled(false);
      if (sample !== undefined && link !== null) {
        const streamedChars = toolChars + textChars;
        const latencyMs = Math.max(0, this.clock() - t0);
        const partial = held.partial;
        // §4.8: every dispatched sample gets a row. An aborted sample (deadline, loser cancellation, or the engine's own abort)
        // yields no result but may have been served — the estimate, or the provider's facts when its callback fired; one that
        // ended rate-limited (every retry a 429, or the abort landed in a 429 backoff) was not served at all; §2 principle 8: a
        // sample the provider failed (stream cut, 5xx once the retries ran out, an error before any byte) is booked too.
        const stopReason = link.signal.aborted ? abortStopReason(sample.signal.aborted ? sample.signal.reason : this.signal.reason) : partial?.rateLimited === true ? 'rate_limited' : 'error';
        this.recordUnfinishedSample(draft, req, attempt, sample, { latencyMs, streamedChars, stopReason, partial });
      }
      // §3.2 (F25): "a hedge makes a step faster, never free" — the cancelled leg of a hedged propose call is booked
      // through the SAME estimator the synthesizer's loser is, so both legs reach `generator.jsonl` and the meter.
      if (sample === undefined && leg !== undefined) {
        const latencyMs = Math.max(0, this.clock() - t0);
        const stopReason = leg.signal.aborted ? 'cancelled' : 'error';
        this.recordUnfinishedSample(draft, req, attempt, { sample: leg.sample ?? 0, purpose: 'propose_fix' }, { latencyMs, streamedChars: toolChars + textChars, stopReason, partial: held.partial, oneShotLeg: true });
      }
      // docs/AGENT-LOOP-DESIGN.md §15 S4 item 7: an agent turn the abort cut (pause-now, Ctrl-C, wall time) or that failed after its
      // retries was still served — booked through the same estimator (its prompt is `agent.messages`), a one-shot row with no index
      if (sample === undefined && leg === undefined && hooks !== undefined) {
        const latencyMs = Math.max(0, this.clock() - t0);
        const stopReason = this.signal.aborted ? abortStopReason(this.signal.reason) : held.partial?.rateLimited === true ? 'rate_limited' : 'error';
        this.recordUnfinishedSample(draft, req, attempt, null, { latencyMs, streamedChars: toolChars + textChars, stopReason, partial: held.partial, oneShotLeg: true });
      }
      throw e;
    } finally {
      endSampleWait();
      link?.unlink();
      if (sample !== undefined) this.noteSampleEnd(draft);
    }
    this.opts.meter.add('generator', res.usage);
    // TUI-DESIGN §9.5: the token counter behind token_cap (input + output; NaN reads as 0 like the meter)
    this.generatorTokens += (Number.isFinite(res.usage.inputTokens) ? res.usage.inputTokens : 0) + (Number.isFinite(res.usage.outputTokens) ? res.usage.outputTokens : 0);
    this.noteUsage('generator', res.model, draft.step, 'propose', res.usage);
    // TUI-DESIGN §9.5: noteUsage read the raw (possibly NaN) cost; the record, the event, the step draft and the sum take the clamped copy
    const usage = pricedUsage(res.usage);
    addUsage(draft.usage.generator, usage);
    // the one-sample call adds the provider's latency; a round's samples close their batch wall in noteSampleEnd.
    // §3.2 (F25): a hedged call has two legs and only the WINNER's latency is the step's, so `generateProposal` adds
    // it once after the race rather than each leg adding its own here.
    if (sample === undefined && leg === undefined) draft.timing.generatorMs += res.latencyMs;
    // §3.4 (F25): the provider's own cache shares of this step's propose call, for `StepRecord.verify` and the §8.3 row
    if (this.s2 !== 'off') {
      draft.verify.s2.cacheRead += Number.isFinite(res.usage.cacheReadTokens) ? (res.usage.cacheReadTokens ?? 0) : 0;
      draft.verify.s2.cacheWrite += Number.isFinite(res.usage.cacheWriteTokens) ? (res.usage.cacheWriteTokens ?? 0) : 0;
    }
    const promptHash = promptHashOfRequest(req);
    if (sample !== undefined && draft.arrivedSamples.length < CACHED_SAMPLES_MAX) {
      // contract 1.4 (§6.4): the arrived sample joins the step's round cache (bounded), so a pause-now keeps what was bought
      const body = JSON.stringify(res);
      if (body !== undefined && body.length <= CACHED_SAMPLE_MAX_CHARS) draft.arrivedSamples.push({ sample: sample.sample, purpose: sample.purpose, promptHash, result: JSON.parse(body) as GenerateResult });
    }
    this.pushGeneratorRecord(draft, {
      step: draft.step,
      attempt,
      promptHash,
      model: res.model,
      // the request's own values (the propose stage sends opts.generation; a sample may differ per §4.6)
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      usage,
      latencyMs: res.latencyMs,
      stopReason: res.stopReason,
      malformed: false,
      // §3.2 (F25) / review defect A3: a WINNING hedge leg carries its index too. Without it a twin that won wrote
      // a row `hedgeOriginOf` could not read back — contradicting the comment on `at` above and §7.6a — and the
      // loser was the only leg counted, so a step that SUCCEEDED reported `samples: 1, cancelled: 1`. The ORIGIN
      // leg has no index (`OneShotLeg.sample` is set only on the twin), so an unhedged call's row is unchanged.
      ...(sample !== undefined ? { sample: sample.sample, purpose: sample.purpose } : leg?.sample === undefined ? {} : { sample: leg.sample, purpose: 'propose_fix' as const }),
      ...(res.usage.reasoningTokens !== undefined ? { reasoningTokens: res.usage.reasoningTokens } : {}),
      ...(res.generationId !== undefined ? { generationId: res.generationId } : {}),
      ...(res.servedProvider !== undefined ? { servedProvider: res.servedProvider } : {}),
      // the chain recovered from a 429: the round's classification reads it, the result is the result
      ...(res.rateLimited === true ? { rateLimited: true } : {}),
    }, sample === undefined && leg !== undefined ? 'one-shot-leg' : 'sample');
    this.emit({ type: 'generator:end', step: draft.step, usage, latencyMs: res.latencyMs, finishReason: res.stopReason, ...at });
    return res;
  }

  /**
   * §4.8: one row per call, under the step the call was dispatched in, and the step's own verification tallies (§9.3). A row
   * that arrives after its step was committed or discarded — a round draining across the step boundary, a sample the
   * synthesizer let run past `synthesize()` — cannot ride the step's flush any more: it is appended at once, never dropped.
   *
   * `counts` (review defect A3): `draft.verify.samples` / `timeouts` / `cancelled` / `malformed` are the
   * SYNTHESIZER's round tallies — §9.3's "how many candidates did the sieve's LLM source produce, and how many
   * of them died". A §3.2 hedge leg of the one-shot propose call carries a `sample` index for one reason only,
   * that `hedgeOriginOf` can read the twin back off its `generator.jsonl` row; it is not a sample of a round,
   * there is no round, and counting it made a jev-on-next arm with S2 on report
   * `samples == cancelled == (hedged steps)` — a 100 % cancellation rate on an arm that has no synthesizer.
   * The legs are recorded where they belong instead: `StepVerifySummary.hedges` / `hedgeWins`.
   */
  private pushGeneratorRecord(draft: StepDraft, rec: GeneratorCallRecord, counts: 'sample' | 'one-shot-leg' = 'sample'): void {
    if (rec.sample !== undefined && counts === 'sample') {
      draft.verify.samples += 1;
      if (rec.stopReason === 'timeout') draft.verify.timeouts += 1;
      else if (rec.stopReason === 'cancelled') draft.verify.cancelled += 1;
      if (rec.malformed) draft.verify.malformed += 1;
    }
    // contract 1.4 (§7.2, §11 row 41): rows of a pause-now-discarded attempt are marked, so the replayed step's rows stay apart
    if (draft.discarded) rec.discarded = true;
    if (draft.closed) this.persist(this.store.appendGenerator(rec), 'generator.jsonl');
    else draft.generatorRecords.push(rec);
  }

  /**
   * docs/LLM-JEV-DESIGN.md §9.3: `StepRecord.verify` of an llm-jev step the synthesizer proposed — the engine's tallies of the
   * sample rows (samples, timeouts, cancelled, malformed) and the proposal's evidence (`candidatesTested` of the committed
   * decision), with whatever the synthesizer reported through `SynthesisContext.reportVerify` merged over them (a run-wide
   * `candidatesTested`, `distinct`, `misanchored`, `passers`, `partials`, `graceMs`, `localisationMissed`).
   */
  private verifySummary(draft: StepDraft, proposal: Proposal | null): StepVerifySummary {
    const s2 = draft.verify.s2;
    const own: StepVerifySummary = {
      samples: draft.verify.samples,
      distinct: 0,
      malformed: draft.verify.malformed,
      timeouts: draft.verify.timeouts,
      cancelled: draft.verify.cancelled,
      misanchored: 0,
      candidatesTested: proposal?.evidence?.candidatesTested ?? 0,
      passers: 0,
      partials: 0,
      graceMs: 0,
      localisationMissed: false,
      // contract 1.9 (Fastlane) §3.1–§3.4 (F25): what the ENGINE measured about this step's propose call. Each member
      // is ABSENT when nothing measured it, which is what keeps the llm-jev shape (where the synthesizer reports its
      // own, merged over these below) exactly what it was — an S2-off step contributes none of them.
      ...(s2.ttfbMs.length > 0 ? { ttfbMs: [...s2.ttfbMs] } : {}),
      ...(s2.hedges > 0 ? { hedges: s2.hedges, hedgeWins: s2.hedgeWins } : {}),
      ...(s2.cacheRead > 0 ? { cacheRead: s2.cacheRead } : {}),
      ...(s2.cacheWrite > 0 ? { cacheWrite: s2.cacheWrite } : {}),
    };
    return { ...own, ...(draft.verify.reported ?? {}) };
  }

  /** llm-jev: one controller aborted by either the sample's signal (deadline / cancellation) or the engine's (stop / budget). */
  private linkSample(sample: SampleOptions): { signal: AbortSignal; unlink: () => void } {
    const engine = linkedAbort(this.signal);
    const onAbort = (): void => engine.controller.abort(sample.signal.reason);
    if (sample.signal.aborted) onAbort();
    else sample.signal.addEventListener('abort', onAbort, { once: true });
    return {
      signal: engine.controller.signal,
      unlink: () => {
        engine.unlink();
        sample.signal.removeEventListener('abort', onAbort);
      },
    };
  }

  /**
   * docs/LLM-JEV-DESIGN.md §4.8: `generatorMs` of an llm-jev step is the wall of the round (the union of the
   * samples' intervals), never the sum.
   *
   * contract 1.9 (Fastlane) §3.2 / contract 1.4 §12.0.2 P3. "One round per sample batch" is
   * kept by `inFlight === 0`, and `noteSampleEnd` drops `inFlight` to 0 in `generate`'s own `finally`, BEFORE the
   * source's `handleEnd` / `settle` has marked the origin served and cleared its hedge timer. A twin started in
   * that window found `inFlight === 0` and opened a SECOND round for one batch: `llmRounds` 2 where the round is
   * one, so `PausePoint.llmRound.round` names a round the synthesizer never ran and the batch wall restarts
   * mid-round. A hedge twin is not a round — it is a second copy of a sample of the round already open
   * (`HEDGE_TWIN_OFFSET`, `hedgeOriginOf`) — so it takes the batch wall when it is the only sample in flight and
   * never the round counter. Every other sample index is unchanged, which is what keeps the PausePoint contract
   * tests reading exactly what they read before.
   */
  private noteSampleStart(draft: StepDraft, sample: number): void {
    const b = draft.generatorBatch;
    if (b.inFlight === 0) {
      b.startedAt = this.clock();
      // contract 1.4 (§12.0.2 PausePoint.round): one round per sample batch of the step
      if (hedgeOriginOf(sample) === null) draft.llmRounds += 1;
    }
    b.inFlight += 1;
  }

  private noteSampleEnd(draft: StepDraft): void {
    const b = draft.generatorBatch;
    b.inFlight = Math.max(0, b.inFlight - 1);
    if (b.inFlight === 0) draft.timing.generatorMs += Math.max(0, this.clock() - b.startedAt);
  }

  /**
   * docs/LLM-JEV-DESIGN.md §4.8 / §2 principle 8: a sample that yields no GenerateResult — aborted by its deadline or a loser
   * cancellation, failed by the provider, or rate-limited — is still booked, one generator.jsonl row with `cancelled: true`
   * and `stopReason` 'timeout' | 'cancelled' | 'error' | 'rate_limited', under the step it was dispatched in. Its usage, in
   * order of what is known (core/types.ts `CancelledGeneration` precedence):
   *   - the accounting frame had arrived (`usage`): read and priced like a completed call;
   *   - nothing was served — the provider said the sample ended rate-limited without a stream (`rateLimited`), or it answered
   *     an error before any byte reached the client (no callback, nothing streamed): zero, a fact, not an estimate (an
   *     estimate here would charge the spend cap for prompts a 4xx / 5xx never ran);
   *   - else the estimate — an abort before the headers (the prompt may still be billed) or a sample that had streamed: input
   *     tokens = a finished sibling's prompt tokens (same prompt hash: the round shares one prefix; any other finished row — an
   *     L2 reproduction request, an earlier round — is a different prompt and says nothing), else the prompt's chars / 4;
   *     output tokens = streamed chars / 4 (the provider's count of tool, text and reasoning chars when its callback fired,
   *     else the engine's own count of the deltas it saw); cost per `estimateCostUsd`; `estimated: true`.
   * Every usage is metered so the spend cap and the token cap see it. The ids the callback carried (`generationId`,
   * `servedProvider`) go on the row, so `GET /api/v1/generation?id=` can replace an estimate post hoc.
   */
  private recordUnfinishedSample(
    draft: StepDraft,
    req: GenerateRequest,
    attempt: number,
    // F25: only the index and the purpose are read, so a hedged one-shot leg books itself through the same estimator;
    // null = an agent turn (docs/AGENT-LOOP-DESIGN.md §15 S4 item 7), whose row and event carry no index, like its served row
    sample: Pick<SampleOptions, 'sample' | 'purpose'> | null,
    o: { latencyMs: number; streamedChars: number; stopReason: 'timeout' | 'cancelled' | 'error' | 'rate_limited'; partial: CancelledGeneration | null; oneShotLeg?: boolean },
  ): void {
    const promptHash = promptHashOfRequest(req);
    const p = o.partial;
    const unserved = p !== null ? p.rateLimited === true : o.stopReason === 'error' && o.streamedChars === 0;
    let raw: TokenUsage;
    if (p !== null && p.usage !== undefined) {
      raw = { ...p.usage, calls: 1 };
    } else if (unserved) {
      raw = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 };
    } else {
      const sibling = draft.generatorRecords.find((r) => r.cancelled !== true && r.promptHash === promptHash);
      const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0) + agentMessageChars(req);
      const inputTokens = sibling !== undefined ? sibling.usage.inputTokens : Math.ceil(promptChars / 4);
      const streamedChars = p !== null ? p.toolChars + p.reasoningChars + p.text.length : o.streamedChars;
      const outputTokens = Math.ceil(streamedChars / 4);
      raw = { inputTokens, outputTokens, costUsd: this.estimateCostUsd(sibling, inputTokens, outputTokens), calls: 1, estimated: true };
    }
    this.opts.meter.add('generator', raw);
    this.generatorTokens += raw.inputTokens + raw.outputTokens;
    this.noteUsage('generator', this.opts.provider.model, draft.step, 'propose', raw);
    // TUI-DESIGN §9.5: noteUsage read the raw (possibly NaN = unpriced) cost; the record, the event and the step sum take the clamped copy
    const usage = pricedUsage(raw);
    addUsage(draft.usage.generator, usage);
    this.pushGeneratorRecord(draft, {
      step: draft.step,
      attempt,
      promptHash,
      model: p?.model ?? this.opts.provider.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      usage,
      latencyMs: o.latencyMs,
      stopReason: o.stopReason,
      malformed: false,
      ...(sample !== null ? { sample: sample.sample, purpose: sample.purpose } : {}),
      cancelled: true,
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(p?.generationId !== undefined ? { generationId: p.generationId } : {}),
      ...(p?.servedProvider !== undefined ? { servedProvider: p.servedProvider } : {}),
      ...(p?.rateLimited === true ? { rateLimited: true } : {}),
      // review defect A3: a losing §3.2 leg is booked exactly like a losing sample — metered, priced, one row —
      // but it is not a sample of a synthesizer round and does not join that round's tallies
    }, o.oneShotLeg === true ? 'one-shot-leg' : 'sample');
    this.emit({ type: 'generator:end', step: draft.step, usage, latencyMs: o.latencyMs, finishReason: o.stopReason, ...(sample !== null ? { sample: sample.sample } : {}) });
  }

  /**
   * §4.8 / §8 (cancelled samples at full price): the estimate's cost. A finished same-prompt sibling's served rate ($/token
   * over its own call) first, else the run's mean generator rate so far, else the pricing table — `opts.generatorPricing`
   * (the resolved config, overrides included) or the built-in row for `provider.model` — at its separate input / output
   * rates. A model the table does not know, with nothing served yet, is unpriced: NaN, which `noteUsage` turns into
   * `budget:unpriced` exactly as a real call without `usage.cost` — never a silent $0 the spend cap cannot see.
   */
  private estimateCostUsd(sibling: GeneratorCallRecord | undefined, inputTokens: number, outputTokens: number): number {
    const tokens = inputTokens + outputTokens;
    if (sibling !== undefined) {
      const served = sibling.usage.inputTokens + sibling.usage.outputTokens;
      if (served > 0 && Number.isFinite(sibling.usage.costUsd)) return (sibling.usage.costUsd / served) * tokens;
    }
    const snap = this.opts.meter.snapshot();
    if (this.generatorTokens > 0 && Number.isFinite(snap.generator.costUsd)) return (snap.generator.costUsd / this.generatorTokens) * tokens;
    let table = this.opts.generatorPricing ?? null;
    if (table === null) {
      const row = lookupPricing(this.opts.provider.model);
      if (row.known) table = row.pricing;
    }
    if (table === null) return Number.NaN;
    return (inputTokens * table.inputPerM + outputTokens * table.outputPerM) / 1e6;
  }

  // -------------------------------------------------------------------------------------
  // One step
  // -------------------------------------------------------------------------------------

  // -------------------------------------------------------------------------------------
  // contract 1.5 (ORCHESTRATION-DESIGN §3, §4.2 P9, §8.2 D1 item 15): the decompose stage's call site
  // -------------------------------------------------------------------------------------

  /**
   * §3.1 [G21] / §2.5(e) / [G5] — **THE ONE SHORT-CIRCUIT**, and the only place it is decided.
   *
   * `orchestrate.split === 'off'` (the shipping default), `orchestration.depth === 1` (an agent may never
   * spawn agents) and a missing coordination ledger are each decided from the RESOLVED OPTIONS alone.
   * Nothing past this predicate runs for them: no `statusPorcelain`, no `os.availableParallelism()`, no
   * `os.freemem()`, no `statfs`, no `du -sk` of the repo, no `git ls-files`, no `propose_split` generator
   * call and no Jev request — because `GateInput` wants every one of those measurements, and M2's gate is
   * that a shut split costs this comparison and nothing else.
   *
   * It emits nothing, either. §3.1's `decompose:skipped` line exists to make the GATE testable; `split_off`
   * is the setting the user chose, not news, and M2 asserts a default run produces no new events at all.
   */
  private decomposeShortCircuit(): GateReason | null {
    const o = this.opts.orchestration;
    return decomposeShutByOptions(this.opts.splitPolicy, o?.depth, this.hasLedger());
  }

  /**
   * contract 1.4 (W2b), ORCHESTRATION-DESIGN §3.1 [G5]: "a coordination ledger handle exists, so children can be
   * tracked". `OrchestrationOptions.hasLedger` rode the orchestration options only because contract 1.4 had not
   * landed `EngineOptions.coordination`; it has now, so the FACT is derived from the handle and the field is the
   * override it always read as. The field stays (contract 1.5 shipped it, and a test may still set it), but a
   * caller that passes a real handle no longer has to remember to set a second flag that says so — which is exactly
   * the drift [G5] would have produced: a parent that delegates with no ledger to track the children in.
   */
  private hasLedger(): boolean {
    return this.coord !== null || this.opts.orchestration?.hasLedger === true;
  }

  /**
   * §3: the stage, before `replan` / `intent`. Returns a stop reason when the delegation was accepted —
   * that is **P9**, and the parent's process ends there (§2.9: waiting on children with a live process
   * burns context and money for nothing).
   *
   * Every other outcome returns null and the step goes on exactly as it would have: the stage is a
   * PROPOSAL (§3), it never touches the workspace, and a rule-1 discard of it costs one Jev request.
   */
  private async maybeDecompose(draft: StepDraft): Promise<StopReason | null> {
    if (this.decomposeShortCircuit() !== null) return null;
    // corner row 12: this run already delegated. The gate stays shut and the existing delegation is
    // adopted — `agent:adopted` says so — for as long as `manifestId` AND `baseSha` still match.
    if (this.orchestration !== null) {
      await this.adoptExistingDelegation();
      return null;
    }

    const t0 = this.clock();
    try {
      const facts = await this.decomposeFacts();
      const result = await this.stage('decompose', () =>
        runDecomposeStage(this.decomposeContext(draft), {
          policy: this.opts.splitPolicy ?? DEFAULT_SPLIT_POLICY,
          depth: this.opts.orchestration?.depth ?? 0,
          runId: this.runId,
          sessionId: this.opts.session?.sessionId ?? this.runId,
          plan: this.plan,
          planDraft: { done: this.plan.done.map((d) => d.text), remaining: [...this.plan.remaining], openProblems: [...this.plan.openProblems] },
          reserveUsd: this.decomposeReserveUsd(),
          reserveFrom: 'session',
          facts,
          detectSecrets: (text) => detectSecrets(text).length,
          // there is no engine-side verbose gate: `--json=verbose` is filtered in `src/cli/json-stream.ts`
          // by `VERBOSE_ONLY_TYPES`, so the engine emits and the stream drops. `decompose:skipped` must be
          // added to that set (one word, CLI-owned); until then it rides an ordinary `--json` stream.
          verbose: true,
          // corner row 11: no blocker means `--no-input` / a pipe / the bench, and the confirm cannot be answered
          hasBlocker: this.opts.blocker !== undefined,
          confirm: (req) => this.confirmDecomposition(draft, req),
        }),
      );
      if (result.kind === 'proposed') return await this.acceptDelegation(draft, result.manifest);
      if (result.kind === 'declined' || (result.kind === 'no_split' && result.problem !== null)) {
        // §3.7 policy / corner row 9: an `orchestration` harness problem sends the next `splitEvery` steps
        // single-threaded. `lastSplitStep` is NOT moved: only a written manifest consumes a `maxSplits` slot.
        const text = result.kind === 'declined' ? result.reason : (result.problem ?? result.reason);
        this.plan = { ...this.plan, harnessProblems: boundHarnessProblems([...this.plan.harnessProblems, { kind: 'orchestration', text: clip(text, 600), step: draft.step }], PLAN_MAX_HARNESS_PROBLEMS) };
        draft.notes.push(`decompose: ${clip(text, 200)}`);
      }
      return null;
    } catch (e) {
      // §3.5: nothing about a decomposition may end a run. An abort still propagates (the step is a rule-1
      // discard, and §3's "it is a proposal" means there is nothing to roll back).
      if (isAbortError(e) || this.signal.aborted) throw e;
      this.emit({ type: 'notice', step: draft.step, kind: 'orchestration', level: 'info', text: `decompose failed: ${clip(this.redact(e instanceof Error ? e.message : String(e)), 200)} — continuing single-threaded` });
      return null;
    } finally {
      draft.timing.decomposeMs = Math.max(0, this.clock() - t0);
    }
  }

  /** the `DecomposeStageContext` seam: the engine's `ask` / `generate` with the stage's own narrow shape */
  private decomposeContext(draft: StepDraft): DecomposeStageContext {
    const self = this;
    return {
      step: draft.step,
      mode: this.mode,
      task: this.opts.task,
      redact: (s) => self.redact(s),
      now: () => self.clock(),
      emit: (e) => self.emit(e),
      ask: async (state, questions, annotate) => {
        const out = await self.ask(draft, 'decompose', state as JsonObject, questions, annotate);
        return { answers: out.answers, rows: out.rows };
      },
      proposeSplit: () => self.proposeSplit(draft),
    };
  }

  /**
   * §3.3: the generator's ONE call at the gate. Its prose is DISCARDED — only the structured
   * `propose_split` argument survives, and `normalizeSplit` re-derives every safety property of it.
   * `jev-only` has no generator, so `splitToolsFor` returns nothing and this returns null without a call.
   */
  private async proposeSplit(draft: StepDraft): Promise<DraftSplit | null> {
    const policy = this.opts.splitPolicy ?? DEFAULT_SPLIT_POLICY;
    const tools = splitToolsFor(this.mode, policy.maxAgents);
    const tool = tools[0];
    if (tool === undefined) return null;
    const listing = await this.listCandidatesTimed();
    const message = buildSplitMessage({
      step: draft.step,
      task: this.opts.task,
      plan: this.plan,
      prefixTree: splitPrefixTree(listing.map((c) => c.path)),
      failingTests: this.lastTestRun !== null && !this.lastTestRun.allPassed ? [this.lastTestRun.command] : [],
      maxAgents: policy.maxAgents,
      verification: policy.verify,
    });
    const result = await this.generate(draft, { system: buildSystemPrompt({ mode: this.mode, sandboxLevel: this.sandbox.level, toolName: tool.name }), messages: [{ role: 'user', content: message }], maxTokens: this.opts.generation.maxTokens, temperature: this.opts.generation.temperature, tools, toolChoice: { name: tool.name } }, 0);
    const call = result.toolCalls.find((c) => c.name === PROPOSE_SPLIT_TOOL_NAME);
    return call === undefined ? null : parseSplitDraft(call.input);
  }

  /**
   * §3.7 [G2]: the manifest confirm goes through the EXISTING `Confirmer` — the same seam the review card
   * uses, with `title` / `headline` / `body` / `badge` set and [D5c]'s fixed `proposal` / `risk`. There is
   * no second confirmer: `confirm:request` and `confirm:resolved` are emitted exactly as they are for a
   * review, so `--plain`, the SR twin and the `--json` stream all see one familiar pair of events.
   */
  private async confirmDecomposition(draft: StepDraft, req: ConfirmRequest): Promise<ConfirmOutcome> {
    this.emit({ type: 'confirm:request', request: req });
    const c0 = this.clock();
    try {
      const c = this.opts.confirmer;
      const r: ConfirmOutcome = c.confirmDetailed ? await c.confirmDetailed(req, { signal: this.signal }) : { approved: await c.confirm(req, { signal: this.signal }) };
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      const rawNote = typeof r.note === 'string' ? clip(sanitizeStream(r.note).replace(/\s+/g, ' ').trim(), REVIEWER_NOTE_MAX) : '';
      const note = rawNote.length > 0 ? rawNote : undefined;
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: r.approved, aborted: false, ...(note !== undefined ? { note } : {}) });
      return { approved: r.approved, ...(note !== undefined ? { note } : {}) };
    } catch (e) {
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: false, aborted: true });
      if (isAbortError(e) && !this.signal.aborted) this.abort(e.reason === 'signal' ? 'signal' : 'human_abort');
      throw e;
    }
  }

  /**
   * §4.2 **P9**, in the row's exact persist order: `orchestrate/manifest-<n>.json` → `state.json`
   * (`orchestration`, `interrupted = null` — the step committed) → heartbeat → `run:end`. The manifest is
   * written FIRST and awaited, because a `state.json` naming a manifest that is not on disk is a
   * delegation the next process cannot adopt and would therefore propose a second time (corner row 12).
   */
  private async acceptDelegation(draft: StepDraft, manifest: Manifest): Promise<StopReason | null> {
    const write = this.store.writeCache;
    if (write === undefined) {
      this.emit({ type: 'notice', step: draft.step, kind: 'orchestration', level: 'info', text: 'the delegation was approved but this checkpoint store cannot write it — continuing single-threaded' });
      return null;
    }
    try {
      // the store routes an `orchestrate/`-prefixed rel to `<runDir>/orchestrate/` (`checkpoint/store.ts cacheTarget`)
      await write.call(this.store, manifestPath(manifest.step), toJson(manifest));
    } catch (e) {
      this.emit({ type: 'notice', step: draft.step, kind: 'orchestration', level: 'info', text: `the manifest could not be written: ${clip(this.redact(e instanceof Error ? e.message : String(e)), 200)} — continuing single-threaded` });
      return null;
    }
    this.emit({ type: 'orchestration:proposed', step: draft.step, manifest });
    this.orchestration = checkpointOrchestration(manifest);
    // only a WRITTEN manifest consumes a `maxSplits` slot and arms the `splitEvery` cooldown (corner row 8)
    this.splits += 1;
    this.lastSplitStep = draft.step;
    this.absorbDiscardedTiming(draft);
    this.recordDelegatePause(draft.step);
    this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `delegated at step ${draft.step} — ${manifest.agents.length} agents` });
    return 'human_pause';
  }

  /**
   * corner row 12: a resumed run whose `manifestId` AND `baseSha` still match ADOPTS the delegation. The
   * gate stays shut and no second manifest is proposed. A mismatch (the base moved, the plan changed, the
   * file is gone) drops the record so the gate may open again — the alternative is a run that can never
   * delegate because of a manifest it can no longer read.
   */
  private async adoptExistingDelegation(): Promise<void> {
    const held = this.orchestration;
    if (held === null) return;
    const read = await readManifest(nodeManifestIo(this.store.dir), held.step, { task: this.opts.task, remaining: this.plan.remaining });
    const head = this.workspace.gitState?.()?.head ?? null;
    const baseSha = head !== null && head.kind === 'branch' ? head.oid : null;
    // row 12: `manifestId` AND `baseSha` must BOTH still match. A head nothing probed cannot refute the
    // base, so only a head that is KNOWN and different drops the adoption.
    if (read.ok && sameDelegation(read.manifest, { manifestId: held.manifestId, baseSha: read.manifest.baseSha }) && (baseSha === null || baseSha === read.manifest.baseSha)) {
      if (!this.adoptedAnnounced) {
        this.adoptedAnnounced = true;
        this.emit({ type: 'agent:adopted', count: held.agents.length, parentRunId: this.runId });
      }
      return;
    }
    this.emit({ type: 'notice', step: this.step + 1, kind: 'orchestration', level: 'info', text: `the delegation of step ${held.step} no longer matches this checkout (${read.ok ? 'the base moved' : read.reason}) — it is not adopted` });
    this.orchestration = null;
  }

  /** §6.1: `min(sessionRemaining × reserveFraction, maxReserveUsd)`. `w_i` is a code weight; Jev has no say in money. */
  private decomposeReserveUsd(): number {
    const policy = this.opts.splitPolicy ?? DEFAULT_SPLIT_POLICY;
    const snap = this.opts.meter.snapshot();
    // [D6]: a hold is money already promised to an agent that has not spent it yet, so the reserve reads it as gone.
    // `sessionRemainingUsd`'s third argument (D0 item 3) landed, so this is the ONE arithmetic — the twin is deleted.
    const remaining = Math.max(0, sessionRemainingUsd(snap.capUsd, snap.totalUsd, snap.heldUsd ?? 0));
    return Math.max(0, Math.min(remaining * policy.reserveFraction, policy.maxReserveUsd));
  }

  /**
   * Everything `GateInput` and the planner need, measured ONCE, and only ever reached past the
   * short-circuit above. The resource numbers come from the §3.6 probe (`nodePreflightProbe`), which is
   * the one place `node:os` / `statfs` / `du` are touched.
   */
  private async decomposeFacts(): Promise<DecomposeFacts> {
    const policy = this.opts.splitPolicy ?? DEFAULT_SPLIT_POLICY;
    const git = this.workspace.gitState?.() ?? null;
    const headOid = git !== null && git.head !== null && git.head.kind === 'branch' ? git.head.oid : null;
    const listing = (await this.listCandidatesTimed()).map((c) => c.path);
    // contract 1.4 (W2b), §3.6: the INJECTED probe (`EngineDeps.preflightProbe`, default `nodePreflightProbe()`),
    // resolved once per engine — the five host readings were the last thing on this path a unit test could not pin
    const probe = this.preflightProbe;
    const disk = await probe.diskFree(this.workspace.root);
    const repoBytes = (await probe.repoBytes(this.workspace.root)) ?? 0;
    const fit = await preflight(probe, { repoRoot: this.workspace.root, want: policy.maxAgents, minFreeBytes: MIN_FREE_BYTES, agentMemBytes: AGENT_MEM_BYTES });
    const verification = resolveVerification({
      configured: policy.verify,
      packageJson: null,
      rootFiles: new Set<string>(),
      makefile: null,
      synthRunner: null,
      lastTestRunCommand: this.lastTestRun?.command ?? this.wsInfo.testCommand?.command ?? null,
    });
    const snap = this.opts.meter.snapshot();
    const measured = await measureRepoFacts((cwd, args, o) => runGit(this.sandbox, cwd, args, o ?? {}), this.workspace.root);
    const problem = [...this.plan.harnessProblems].reverse().find((h) => h.kind === 'orchestration');
    return {
      // [G5]: past the short-circuit this is true by construction — it is re-stated so the gate stays pure
      hasLedger: this.hasLedger(),
      git: { isRepo: git?.repo === true, headBorn: headOid !== null, worktreeSupported: git?.repo === true },
      baseSha: headOid ?? '',
      repoKey: git?.commonDir ?? null,
      existingBranches: measured.existingBranches,
      deny: ['.git', ...this.opts.secretPaths],
      // review 2026-09-22 findings 5 + 6: measured, not `false`/`[]`. Every one of these placeholders made the
      // planner more permissive than the truth; `unmeasured` carries whatever git could not answer and the gate
      // refuses on it rather than guessing. All of it runs BEHIND the short-circuit, so M2 is untouched.
      fold: measured.fold,
      unmeasured: measured.unmeasured,
      repoPaths: listing,
      listing,
      // D1 has no item→file join: `fileMemory` is keyed by path, not by plan item, so the association is
      // computed from the item text against the real listing. Wave D2's evidence join replaces this.
      itemFiles: this.plan.remaining.map((item) => listing.filter((p) => item.includes(p))),
      testImports: {},
      packages: [],
      lastTestRun: this.lastTestRun !== null && !this.lastTestRun.allPassed ? { failingFiles: [this.lastTestRun.command] } : null,
      dirtyEntries: git?.dirty.entries.length ?? 0,
      // [D1]: the OVERLAP is not a fact of the repo — it is the dirty set intersected with the chosen split's
      // owns, which do not exist until the normaliser has run, so the stage derives it at manifest time.
      syncedDirty: measured.syncedDirty,
      liveChildren: 0,
      splits: this.splits,
      lastSplitStep: this.lastSplitStep,
      maxAgentsAllowed: fit.agents,
      preflightReasons: fit.reasons,
      availableParallelism: probe.availableParallelism() ?? 1,
      freeMemBytes: probe.freeMemBytes() ?? 0,
      freeDiskBytes: disk?.freeBytes ?? 0,
      repoBytes,
      sessionRemainingUsd: Math.max(0, sessionRemainingUsd(snap.capUsd, snap.totalUsd, snap.heldUsd ?? 0)),
      isReplanStep: this.detector.tripped(),
      orchestrationProblemAgeSteps: problem === undefined ? null : Math.max(0, this.step + 1 - problem.step),
      verification: verification.commands,
      humanAsked: false,
    };
  }

  private async runStep(): Promise<{ stop: StopReason | null; detail?: string }> {
    const step = this.step + 1;
    const draft = this.newDraft(step);
    this.draft = draft;
    this.stageBlock = null;
    stepTimeline.beginStep(step);
    this.emit({ type: 'step:start', step, startedAt: draft.startedAt });
    // contract 1.4 (COORDINATION-DESIGN §7.3 step 3): the paused proposal (or the arrived samples) of exactly this step, gated at run start
    const replay = this.takeReplay(step);
    const replayed = replay !== null && replay.proposal !== null ? replay : null;
    // §7.3 step 4: no cache for this step means it runs FRESH — whatever a previous pause left is rejected by that fact. The
    // detail goes now (a later discard must not inherit it) and the file is renamed, so no `--replay` can resurrect it.
    if (replay === null) this.supersedeStepCache();
    // llm-jev (docs/LLM-JEV-DESIGN.md §3): replan on a trip, otherwise straight to the synth propose stage — no intent or context request
    let stage: StageName = usesJev(this.mode) ? (this.detector.tripped() ? 'replan' : this.mode === 'llm-jev' ? 'propose' : 'intent') : 'propose';
    let changedFiles: string[] = [];
    let stopAfterCommit: StopReason | null = null;
    let commonState: JsonObject | null = null;
    // docs/AGENT-LOOP-DESIGN.md §2.2: what the agent branch hands the post-step observe (all null in every other mode)
    let agentNext: AgentNext | null = null;
    let agentCtx: AgentContext | null = null;
    let agentImages: AgentImages | null = null;
    const claimsOf = (proposal: Proposal): void => {
      const c = newClaims(this.plan, proposal.plan);
      draft.claims = c.claims;
      draft.claimsDropped = c.dropped;
    };
    try {
      changedFiles = await this.workspace.changedFiles().catch(() => [] as string[]);
      const ctx = this.makeContext(draft, changedFiles);

      // contract 1.5 (ORCHESTRATION-DESIGN §3): the `decompose` stage runs HERE — before `replan` / `intent` —
      // and only when the gate can possibly open. `maybeDecompose` short-circuits on `split: 'off'`, on an agent
      // (`orchestration.depth === 1`) and on a missing ledger before it gathers a single gate fact (M2). A
      // `human_pause` back is **P9**: the manifest was written and confirmed, and the parent has nothing left to do.
      const delegated = await this.maybeDecompose(draft);
      if (delegated !== null) return { stop: delegated, detail: `delegated at step ${step}` };
      const common = (): JsonObject => (commonState ??= this.commonState(changedFiles, this.window));

      if (usesJev(this.mode)) {
        if (this.detector.tripped()) {
          stage = 'replan';
          const lastOutcomes = this.window.map((w) => w.outcome);
          const r = await this.stage('replan', () => runReplanStage(ctx, common(), this.detector, lastOutcomes));
          if (r.kind === 'stop') {
            this.emit({ type: 'transcript', step, level: 'info', text: `replan: ${r.reason} (move ${r.directive.move} p=${r.directive.probability.toFixed(2)}, task_impossible=${r.directive.taskImpossible.toFixed(2)})` });
            this.absorbDiscardedTiming(draft);
            return { stop: r.reason, detail: `task_impossible=${r.directive.taskImpossible.toFixed(2)}` };
          }
          const exit = this.repeatedGatherContextExit(r.directive);
          if (exit !== null) {
            this.emit({ type: 'transcript', step, level: 'info', text: `replan: ${exit}; treated as stop_and_report (DESIGN §5.5: a third identical refused completion claim after gathering context is the exit)` });
            this.absorbDiscardedTiming(draft);
            return { stop: 'replan_stop', detail: exit };
          }
          draft.directive = r.directive;
        }
        const llmJev = this.mode === 'llm-jev';
        let intentInfo: { intent: Intent; answer: IntentAnswer; probability: number };
        let contextFiles: FileView[] = [];
        if (replayed !== null) {
          // §7.3 step 3: intent / context / propose are skipped — the cached results stand; risk always re-runs below
          const ri = replayed.intent;
          if (ri !== null) draft.intent = { intent: ri.intent, answer: ri.answer, verdict: ri.verdict, probability: ri.probability, confidence: ri.confidence, pairedNoul: ri.pairedNoul, planStillValid: ri.planStillValid };
          intentInfo = ri !== null ? { intent: ri.intent, answer: ri.answer, probability: ri.probability } : { intent: INTENT_FALLBACK, answer: INTENT_FALLBACK, probability: 1 };
          draft.contextFiles = [...replayed.contextFiles];
          draft.directive = replayed.directive;
        } else if (llmJev) {
          // docs/LLM-JEV-DESIGN.md §3 rows 2–3 / §13: no intent Choice and no context Nouls — the synthesizer holds every
          // file itself and `draft.intent` is code-derived from the proposal kind once the synth stage returned
          intentInfo = { intent: INTENT_FALLBACK, answer: INTENT_FALLBACK, probability: 1 };
        } else {
          stage = 'intent';
          draft.intent = await this.stage('intent', () => runIntentStage(ctx, common()));
          if (draft.intent.verdict === 'fallback') draft.observed = true;
          stage = 'context';
          intentInfo = { intent: draft.intent.intent, answer: draft.intent.answer, probability: draft.intent.probability };
          const cx = await this.stage('context', () => runContextStage(ctx, common(), intentInfo));
          draft.contextFiles = cx.files.map((f) => f.path);
          contextFiles = cx.files;
        }
        stage = 'propose';
        let p: { proposal: Proposal };
        if (replayed !== null) {
          p = { proposal: replayed.proposal! };
          this.emitReplayedProposal(draft, replayed);
        } else if (this.mode === 'jev-only' || llmJev) {
          // The Synthesizer proposes (docs/JEV-ONLY.md): in jev-only no generator call, no generator:* events, no generator.jsonl
          // row; in llm-jev the synthesizer spends generator samples through SynthesisContext.generate (docs/LLM-JEV-DESIGN.md §4.8).
          const synthesizer = this.synthesizer;
          if (synthesizer === null) throw new ConfigError(`${this.mode} mode requires a synthesizer`, { setting: 'mode' });
          // docs/LLM-JEV-DESIGN.md §9.4: a workspace the synthesizer does not cover (non-Python, no tests, feature work) falls back per step
          // to the generic `propose_action` sample — the flag (not the mode) keys `generator_done` and the verbatim claim evidence
          if (llmJev && !(await this.synthesizerHandles(synthesizer))) {
            draft.proposer = 'generic';
            const listing = await this.listCandidatesTimed();
            const candidates = prefilterCandidates(this.opts.task, listing, new Set([...changedFiles, ...this.createdThisRun]));
            // review D5: the same entry point as the other two, so the meter and the view follow the mode gate in one place
            p = await this.stage('propose', () => this.proposeWithContext(ctx, draft, changedFiles, [], candidates));
            this.flushGeneratorRecords(draft);
          } else {
            if (llmJev) draft.proposer = 'synth';
            // contract 1.4 (§8.8 column 3): llm-jev's synthesizer prompts the generator itself, so it gets the
            // relaxed view as text; jev-only builds none (`contextEnabled` is false) and this is `undefined`.
            const sctx = this.synthesisContext(draft, contextFiles, await this.synthContextText(draft, changedFiles));
            const s0 = this.clock();
            const jev0 = draft.timing.jevMs;
            const jevWall0 = draft.timing.jevWallMs;
            try {
              p = await this.stage('propose', () => runSynthStage(ctx, synthesizer, sctx));
            } finally {
              // docs/LLM-JEV-DESIGN.md §7.5: the synth wall and the Jev latency spent inside it (the shell's share is the rest)
              draft.synthMs = Math.max(0, this.clock() - s0);
              draft.synthJevMs = Math.max(0, draft.timing.jevMs - jev0);
              draft.synthJevWallMs = Math.max(0, draft.timing.jevWallMs - jevWall0);
            }
            // llm-jev: the round's per-sample rows (cancelled estimates included) reach generator.jsonl exactly as after runProposeStage; a no-op in jev-only
            this.flushGeneratorRecords(draft);
          }
        } else {
          // contract 1.9 (Fastlane) docs/LLM-LOOP-DESIGN.md §4 (route R9): ONE bounded sieve round on the one shape the
          // search provably wins, before the LLM is asked to guess. A branch route, not a race: when it declines (which
          // is every step where the predicate does not hold, at zero cost) the code default below runs unchanged.
          const armed = await this.fastPathArm(draft);
          // §4.4 / the stage contract: stage 1 is free and silent, so a decline emits nothing; the ROUND is a propose
          // like every other propose and runs inside the stage. A step whose round fired and declined therefore has
          // two propose spans — the round's and the LLM's — both matched, rather than one unmatched sequence.
          const fast = armed === null ? null : await this.stage('propose', () => this.fastPathRound(draft, armed));
          if (fast !== null) {
            draft.proposer = 'fastpath';
            p = { proposal: fast };
          } else {
            // docs/COORDINATION-DESIGN.md §8.8 jev-on column: Jev's picks first, then the cache; the meter recomputed once the prompt is built
            p = await this.stage('propose', () => this.proposeWithContext(ctx, draft, changedFiles, contextFiles, null));
            this.flushGeneratorRecords(draft);
          }
        }
        draft.proposal = p.proposal;
        draft.proposeCompleted = true;
        claimsOf(p.proposal);
        if (llmJev) {
          // §3 row 2: the intent is a code fact of the proposal kind (patch → edit, run → verify, done → finish, read → investigate).
          // It cannot exist before the proposal, so in this mode the `intent` event follows `proposal` (core/types.ts documents
          // the order; `verdict: 'code'` marks it) — no provisional intent is emitted, because none would be a fact.
          draft.intent = codeIntent(p.proposal.action.kind);
          intentInfo = { intent: draft.intent.intent, answer: draft.intent.answer, probability: 1 };
          this.emit({ type: 'intent', step, intent: draft.intent.intent, answer: draft.intent.answer, probability: 1, confidence: 1, verdict: 'code' });
        }
        stage = 'risk';
        const rk = await this.stage('risk', () => runRiskStage(ctx, common(), p.proposal, intentInfo, { verifiedCompletion: this.verifiedCompletion(p.proposal) }));
        draft.risk = rk.risk;
        // contract 1.9 (Fastlane) §2.4 / §7.5 seam (c): the code-first gate's audit trail. Both are undefined on
        // the routers-off path, so the draft keeps its nulls and the record keeps neither member (I2).
        if (rk.riskSource !== undefined) draft.riskSource = rk.riskSource;
        if (rk.jevUnavailable !== undefined) draft.jevUnavailable = rk.jevUnavailable;
        draft.matchesIntent = rk.matchesIntent;
        draft.patchTargets = rk.targets;
        if (rk.risk.verdict === 'block') {
          draft.outcome = { status: 'blocked', reason: rk.risk.reason };
          this.counters.blocked += 1;
          this.emit({ type: 'outcome', step, outcome: draft.outcome });
        } else if (rk.risk.verdict === 'review' && (this.opts.autonomy ?? 'full') === 'full' && this.opts.orchestration?.depth !== 1) {
          // (a child agent — depth 1 — has no human and never auto-approves: ORCHESTRATION-DESIGN §2.5(c) row 29 parks it below)
          // autonomy: full (the default) — a review verdict is approved without asking; the reason is kept where a reader
          // and the next prompt see it, and `block` above is still the only verdict that stops an action
          this.counters.reviews += 1;
          draft.notes.push(`review auto-approved (autonomy: full): ${rk.risk.reason}`);
          this.emit({ type: 'transcript', step, level: 'info', text: `review · auto-approved (autonomy: full) · ${rk.risk.reason}` });
        } else if (rk.risk.verdict === 'review') {
          const outcome = await this.confirm(draft, p.proposal, rk.risk);
          // Counted only once the review resolved: an abort while it is pending discards the step
          // (§9.1 rule 1) and the resumed run asks again, so counting early would double it.
          this.counters.reviews += 1;
          // TUI-DESIGN §6.4 (P6): the reviewer's `d` note reaches the window notes and, on a decline, the reason Jev and the generator see
          if (outcome.note !== undefined) draft.notes.push(`reviewer note: ${outcome.note}`);
          if (!outcome.approved) {
            const identity = this.opts.confirmer.identity;
            const base = identity === 'reviewer' ? `declined by reviewer: ${rk.risk.reason}` : `not approved (${identity}): ${rk.risk.reason}`;
            const reason = outcome.note !== undefined ? `${base} — reviewer note: ${outcome.note}` : base;
            draft.outcome = { status: 'declined', reason };
            this.counters.declined += 1;
            this.emit({ type: 'outcome', step, outcome: draft.outcome });
          }
        }
      } else if (this.mode === 'agent') {
        // docs/AGENT-LOOP-DESIGN.md §2.2 / §2.3: the driver proposes — the twin of the synth branch. No intent, context, risk,
        // judge or replan stage runs: an `observe` step is finished inside the driver, and `act` / `verify` / `finish` run through
        // the shared tail below, after which the driver observes the result before the checkpoint.
        stage = 'propose';
        draft.proposer = 'agent';
        const driver = this.agentDriverOrThrow();
        const actx = this.agentContext(draft);
        agentCtx = actx;
        let next: AgentNext;
        try {
          next = await this.stage('propose', () => runAgentStage(ctx, driver, actx));
        } catch (e) {
          // §3.1 / §10: a ConfigError from the driver (AgentTranscriptMissingError on --resume) refuses the run — fatal, exit 2, and
          // no step is committed, the way a throwing factory ends it; retrying such a resume must not append failed steps
          if (!(e instanceof ConfigError) || this.signal.aborted) throw e;
          this.fatalError = e;
          this.lastErrorStage = 'propose';
          this.emit({ type: 'error', step, error: serializeError(e, this.redact), fatal: true });
          this.absorbDiscardedTiming(draft);
          return { stop: 'error' };
        }
        agentNext = next;
        draft.proposal = next.proposal;
        draft.proposeCompleted = true;
        draft.agent = next.summary;
        claimsOf(next.proposal);
        if (next.kind === 'observe') {
          // §2.3: a read-only segment the driver already resolved — the outcome is final, nothing executes, no images
          draft.outcome = next.outcome;
          draft.output = next.output;
          draft.timing.execMs += next.execMs;
          this.emit({ type: 'outcome', step, outcome: next.outcome });
        } else if (next.kind === 'act') {
          stage = 'execute';
          draft.patchTargets = await computeTargets(ctx, next.proposal);
          // ORCHESTRATION-DESIGN §2.4 belt 2: a property of the agent, not of the mode — applied here as in jev-off
          const refusal = ownershipRefusal(next.proposal.action, this.opts.orchestration);
          if (refusal !== null) {
            draft.outcome = refusal;
            this.counters.blocked += 1;
            this.emit({ type: 'outcome', step, outcome: refusal });
          } else await this.applyAgentGate(draft, next.proposal, next.gate);
        }
      } else {
        stage = 'propose';
        let p: { proposal: Proposal };
        if (replayed !== null) {
          p = { proposal: replayed.proposal! };
          this.emitReplayedProposal(draft, replayed);
        } else {
          // Same <= 300 pre-filter (mention count, then recency) as the context stage (§13).
          const listing = await this.listCandidatesTimed();
          const candidates = prefilterCandidates(this.opts.task, listing, new Set([...changedFiles, ...this.createdThisRun]));
          // docs/COORDINATION-DESIGN.md §8.8 jev-off column: the cache is the generator's only file view; candidates stay the listing
          p = await this.stage('propose', () => this.proposeWithContext(ctx, draft, changedFiles, [], candidates));
          this.flushGeneratorRecords(draft);
        }
        draft.proposal = p.proposal;
        draft.proposeCompleted = true;
        claimsOf(p.proposal);
        stage = 'execute';
        draft.patchTargets = await computeTargets(ctx, p.proposal);
        // ORCHESTRATION-DESIGN §2.4 belt 2: jev-off runs no risk stage, so the child's code refusal is applied here —
        // belt 2 is a property of the AGENT, not of the mode (`runRiskStage` carries it in every other mode).
        const refusal = ownershipRefusal(p.proposal.action, this.opts.orchestration);
        if (refusal !== null) {
          draft.outcome = refusal;
          this.counters.blocked += 1;
          this.emit({ type: 'outcome', step, outcome: refusal });
        }
      }

      if (draft.outcome === null && draft.proposal !== null) {
        // Await the overlapped checkpoint of the previous step before anything touches the workspace (§9).
        if (this.pendingCheckpoint) await stepTimeline.measure('store', 'pending-checkpoint', () => this.pendingCheckpoint ?? Promise.resolve());
        if (this.blocked !== null) {
          // TUI-DESIGN §13.3: that checkpoint failed on a disk class (or a pause was requested by a write): nothing executes until the pane is answered
          this.interrupted = { step, stage: 'execute', proposal: draft.proposal };
          this.emit({ type: 'transcript', step, level: 'warn', text: `${this.blocked.kind} before execute; step ${step} discarded` });
          this.absorbDiscardedTiming(draft);
          return { stop: null };
        }
        // contract 1.4 (W2b), COORDINATION-DESIGN §4.2: the `coordinate` micro-stage, in the design's exact order —
        // after the overlapped checkpoint and the `blocked` discard, BEFORE `checkBudgets` (so a strict wait that ate
        // the wall budget is caught below, not after pre-images) and before `takePreImages` (the latest point at
        // which nothing has touched the workspace).
        if (this.coord !== null && coordinates(draft.proposal.action)) {
          const discard = await this.runCoordinate(draft, step);
          if (discard !== null) {
            this.interrupted = { step, stage: 'execute', proposal: draft.proposal };
            this.emit({ type: 'transcript', step, level: 'warn', text: discard });
            this.absorbDiscardedTiming(draft);
            return { stop: null };
          }
        }
        const b = checkBudgets(this.budgetInput(['spend_cap', 'wall_time']));
        if (b !== null) {
          this.interrupted = { step, stage: 'execute', proposal: draft.proposal };
          this.emit({ type: 'transcript', step, level: 'info', text: `budget ${b} reached before execute; step ${step} discarded` });
          this.absorbDiscardedTiming(draft);
          return { stop: b, detail: 'before_execute' };
        }
        stage = 'execute';
        // TUI-DESIGN §12.3: pre-images of the targets (edit|write|patch) or the dirty set (run) before anything touches the workspace
        const imageSource = imageSourceOf(draft.proposal.action);
        // docs/AGENT-LOOP-DESIGN.md §A5: the dirty set's size and HEAD the command starts from, for the destructive note
        const agentDirty = this.mode === 'agent' ? (this.workspace.dirtySet?.().size ?? changedFiles.length) : 0;
        const agentHead = this.mode === 'agent' ? headOidOf(this.workspace.gitState?.() ?? this.gitState) : null;
        const pre = imageSource !== null ? await this.takePreImages(draft, imageSource, changedFiles) : null;
        if (this.mode === 'agent') agentImages = { pre, dirty: agentDirty, headBefore: agentHead, preChanged: null };
        // contract 1.4 (§7.2): a pause-now (or an abort) that landed while the pre-images were taken discards under rule 1 — execute never starts on an aborted signal
        if (this.signal.aborted) throw this.signal.reason;
        draft.executeStarted = true;
        const ex = await this.stage('execute', () => runExecuteStage(ctx, draft.proposal!));
        draft.outcome = ex.outcome;
        draft.output = ex.output;
        draft.changedFiles = ex.changedFiles;
        draft.tests = ex.tests;
        draft.created = ex.created;
        draft.timing.execMs += ex.execMs;
        draft.executeFinished = true;
        // TUI-DESIGN §12.3: post-images right after execute, still inside runStep() so harnessMs sees them
        // (docs/AGENT-LOOP-DESIGN.md §3.4 / §A5: an agent command's image also covers the dirty-set files it changed)
        const postFiles = agentImages !== null && imageSource === 'run' ? await this.agentPostFiles(draft, agentImages, ex.changedFiles) : ex.changedFiles;
        if (imageSource !== null) await this.takePostImages(draft, imageSource, postFiles, pre);
        // ORCHESTRATION-DESIGN §2.4 [G8]: belt 2 does not cover `run`, so the post-images are diffed against `own` here.
        // Reported, never blocked — "blocking after the command ran would be theatre".
        await this.noteEscaped(draft, ex.changedFiles);
        // ORCHESTRATION-DESIGN §5.7 tail / corner row 44: a merge that landed is recorded, because `/undo` cannot
        // restore a merge commit from images and `/rewind` below the delegation would orphan the branches.
        await this.noteLanded(draft, ex.outcome);
        this.emit({ type: 'outcome', step, outcome: ex.outcome });
        if (ex.outcome.status === 'interrupted') {
          const cls = this.classifyStop();
          draft.interruptedAt = { stage: 'execute', reason: cls.interrupt };
          draft.observed = false;
          stopAfterCommit = cls.stop;
        } else if (this.pauseNow) {
          // contract 1.4 (COORDINATION-DESIGN §7.2 execute row, §12.0.2 P4, §11 row 29): the pause-now landed while execute ran —
          // the command ran to its own end (WAIT, never kill); the judge is skipped with the rule-3 shape, no signal involved; the
          // step commits and the loop top finishes the run at the boundary
          this.pauseLandedInExecute = true;
          if (usesJev(this.mode)) {
            draft.judge = null;
            draft.completion = null;
            draft.interruptedAt = { stage: 'judge', reason: 'human_pause' };
            draft.notes.push('interrupted before judge');
            this.emit({ type: 'transcript', step, level: 'info', text: `step ${step}: pause now landed during execute; the action ran to its end, the judge is skipped (human_pause)` });
          }
        } else if (usesJev(this.mode)) {
          stage = 'judge';
          const recent = pushWindow(this.window, this.provisionalEntry(draft));
          const judgeCommon = this.commonState(await this.workspace.changedFiles().catch(() => changedFiles), recent, draft);
          const j = await this.stage('judge', () =>
            // lastRunOutput: the engine's last parsed test run tail reaches a no-op done state even outside the 4-step window (state.ts doneExecutedJson)
            // verifiedDone: llm-jev only (docs/LLM-JEV-DESIGN.md §6.6) — a `done` after the engine's own passing, current run has its claims accepted by code
            runJudgeStage(ctx, judgeCommon, draft.proposal!, { outcome: ex.outcome, output: ex.output, changedFiles: ex.changedFiles, tests: ex.tests, lastRunOutput: this.lastTestRunOutput }, draft.claims, { verifiedDone: this.verifiedCompletion(draft.proposal!) !== null }),
          );
          draft.judge = j.judge;
          draft.completion = j.completion;
          draft.claimProbabilities = j.claimProbabilities;
        }
      }
    } catch (e) {
      trace(`runStep catch stage=${stage} ${e instanceof Error ? e.name : typeof e}`);
      const handled = await this.handleStepError(e, stage, draft);
      trace(`handleStepError -> discard=${handled.discard} stop=${handled.stop ?? 'null'}`);
      if (handled.discard) {
        this.absorbDiscardedTiming(draft);
        return { stop: handled.stop };
      }
      if (handled.stop) stopAfterCommit = handled.stop;
    }
    if (this.candidateRefresh) {
      await this.candidateRefresh;
      this.candidateRefresh = null;
    }
    // docs/AGENT-LOOP-DESIGN.md §2.2 / §10 commit order: the tool result of an `act` / `verify` / `finish` step reaches the driver's
    // transcript BEFORE the checkpoint — after the try/catch, so a `failed` outcome from handleStepError is observed too
    if (agentNext !== null && agentNext.kind !== 'observe' && agentCtx !== null) await this.observeAgentStep(draft, agentNext, agentCtx, changedFiles, agentImages);
    // ORCHESTRATION-DESIGN §2.6 [G1] [D2] [D10]: the harness commits, in the agent worktree, through the injected
    // `runGit` seam — after every committed step of a child whose outcome is `executed` with changed files. No seam
    // (every run that is not an agent) = no git mutation at all, which is why nothing below changes an ordinary run.
    await this.commitAfterStep(draft);
    const committed = this.commit(draft);
    if (committed.stop) return { stop: committed.stop };
    // §2.4 / corner row 18: three consecutive belt-2 refusals are the honest signal that the DECOMPOSITION failed
    const park = this.noteBeltRefusal(draft);
    if (park !== null) return { stop: 'human_pause', detail: park };
    if (stopAfterCommit) return { stop: stopAfterCommit };
    if (this.unpriced !== null) {
      // TUI-DESIGN §9.5: usage.cost null/non-finite → the step committed, the run stops with error unless --allow-unpriced (exit 2, the flag is named)
      const u = this.unpriced;
      this.fatalError = new ConfigError(`${u.side} usage.cost missing for ${u.model}: the $${this.opts.limits.spendCapUsd.toFixed(3)} spend cap cannot be enforced; pass --allow-unpriced to run under a token cap instead`, { setting: u.side === 'jev' ? 'decider.model' : 'generator.model' });
      this.stateError = { stage: u.stage, code: 'config' };
      return { stop: 'error', detail: 'unpriced_usage' };
    }
    // docs/AGENT-LOOP-DESIGN.md §8 / §A2: AGENT_MAX_BLOCKS destructive refusals pause the run for a human (resumable, no prompt) — a
    // gate `block`, or (the real classifier's shape under `--autonomy review`) a rule-matched review the human declined
    if (this.mode === 'agent' && isAgentRefusal(draft.agentGate, draft.outcome) && ++this.agentBlocks >= AGENT_MAX_BLOCKS) {
      this.emit({ type: 'transcript', step, level: 'warn', text: AGENT_MAX_BLOCKS_LINE });
      return { stop: 'human_pause', detail: 'max_blocks' };
    }
    if (this.completeAfter(draft)) return { stop: 'complete' };
    // docs/AGENT-LOOP-DESIGN.md §A1 / §8: the agent's final answer — `answered` when the whole run was a reply (no tool call, no
    // change, no command: the one predicate `isReplyOnlyRun`), `generator_done` otherwise; both exit 0
    if (this.mode === 'agent' && draft.outcome?.status === 'noop') return { stop: isReplyOnlyRun(this.agentSteps) ? 'answered' : 'generator_done' };
    // docs/LLM-JEV-DESIGN.md §9.4: the generic fallback's `done` (draft.proposer 'generic', stage 4) stops as the generator's, like jev-off
    if ((this.mode === 'jev-off' || draft.proposer === 'generic') && draft.outcome?.status === 'noop') return { stop: 'generator_done' };
    if (this.consecutiveStageFailures >= CONSECUTIVE_STAGE_FAILURE_LIMIT || (this.agentProviderStop && draft.error !== null)) {
      const err = draft.error ?? { stage, code: 'internal' };
      this.stateError = { stage: err.stage, code: err.code };
      return { stop: 'error' };
    }
    return { stop: null };
  }

  /** §7.3 step 3: the restored proposal is announced like a fresh one, plus one line saying it was replayed; the risk stage follows as always */
  private emitReplayedProposal(draft: StepDraft, cache: StepCache): void {
    draft.replayed = true;
    draft.proposer = cache.proposer;
    this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `step ${draft.step}: replaying the paused proposal from ${stepCacheRel(draft.step)} (intent, context and propose skipped; risk re-checked)` });
    // contract 1.4 (§7.3 step 3): the event says it is a replay, so `plain.ts` / the TUI can print `(replayed)` without guessing
    this.emit({ type: 'proposal', step: draft.step, proposal: cache.proposal!, verdict: 'replay' });
  }

  /** TUI-DESIGN §12.3: `writePreImages` for the targets (edit|write|patch) or the dirty set (run: `workspace.dirtySet()`, else the changed files). */
  private async takePreImages(draft: StepDraft, source: ImageSource, changedFiles: readonly string[]): Promise<PreImageResult | null> {
    const action = draft.proposal?.action;
    let targets: string[];
    if (source === 'run') targets = [...(this.workspace.dirtySet?.() ?? changedFiles)];
    else if (draft.patchTargets.length > 0) targets = draft.patchTargets.map((t) => t.path);
    else targets = action !== undefined && (action.kind === 'edit' || action.kind === 'write') ? [action.path] : [];
    // a `run` with nothing dirty has nothing to copy: no pre-image directory (clean tracked files are recoverable from HEAD)
    if (source === 'run' && targets.length === 0) return null;
    const t0 = this.clock();
    // HARNESS-NEXT-DESIGN §5/§6 S0 charters a *reduction* of imagesMs (p95 19.9–24.5 ms, target 15 ms). Wave S0
    // instrumented it and did not reduce it, and once `harnessMs` stopped being charged the decider double's CPU
    // this span became the whole of the gated number: on the `step-overhead` fixture `images:pre` is 386 ms total
    // at p95 38.1 ms against `listing:note-changed` 26 ms, `store` 117 ms and `jev` 98 ms over 203 asks. The cost
    // is the serial 15 MiB pre-image copy inside `writePreImages` — `src/checkpoint/images.ts`, owned by another
    // branch in flight. DEFERRED, with that owner; `experiments/harness-next/quick.mts` prints the deferral on
    // every Ring-0 run so it cannot be quietly forgotten.
    const endImages = stepTimeline.span('images', 'pre');
    try {
      const r = await writePreImages(this.runDir, draft.step, targets, { root: this.workspace.root, source, now: () => this.clock() });
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + r.ms;
      return r;
    } catch (e) {
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + Math.max(0, this.clock() - t0);
      this.noteImagesFailure(draft, 'pre', e);
      return null;
    } finally {
      endImages();
    }
  }

  /** TUI-DESIGN §12.3: `writePostImages` of the changed files with `cleanAtStart` and the HEAD oid from the workspace's probe. */
  private async takePostImages(draft: StepDraft, source: ImageSource, changedFiles: readonly string[], pre: PreImageResult | null): Promise<void> {
    // a `run` that changed nothing and had nothing dirty records no post image (a missing post/<step>.json reads as "no changes")
    if (source === 'run' && changedFiles.length === 0 && pre === null) return;
    // headOid follows the workspace's live view (its gitState() tracks a committing `run`, §12.2); the engine's own probe is the fallback
    const git = this.workspace.gitState?.() ?? this.gitState;
    // cleanAtStart is judged against the ENGINE's probe only: `dirtyAtStart` was built from it, so without it (probe rejected,
    // the workspace probing for itself) nothing reads clean — a `git-restore` undo of a file the human had modified before the
    // run would overwrite those modifications (§12.4 rule 3)
    const probe = this.gitState;
    const t0 = this.clock();
    const endImages = stepTimeline.span('images', 'post');
    try {
      const r = await writePostImages(this.runDir, draft.step, changedFiles, {
        root: this.workspace.root,
        source,
        headOid: headOidOf(git),
        // tracked and unmodified at run start: in a repository, a path outside the run-start dirty set that this run did not create
        cleanAtStart: (rel) => probe !== null && probe.repo && !this.dirtyAtStart.has(rel) && !this.createdThisRun.has(rel) && !draft.created.includes(rel),
        pre,
        now: () => this.clock(),
      });
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + r.ms;
      // docs/COORDINATION-DESIGN.md §8.4: the hashes already computed feed fileMemory at commit (no second read)
      this.lastPostImage = r.image;
    } catch (e) {
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + Math.max(0, this.clock() - t0);
      this.noteImagesFailure(draft, 'post', e);
    } finally {
      endImages();
    }
  }

  /** An image write that failed never fails the step: a warning line, and the disk-class notice when it is one (§13.3). */
  private noteImagesFailure(draft: StepDraft, which: 'pre' | 'post', e: unknown): void {
    this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `${which}-images write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
    this.noteDiskError(e, which === 'pre' ? CHECKPOINT_FILES.pre : CHECKPOINT_FILES.post, draft.step);
  }

  // -------------------------------------------------------------------------------------
  // contract 1.5 — the child differences (ORCHESTRATION-DESIGN §2.4, §2.5, §2.6) and the launch (§5.7).
  // Every method below returns at once on a run without `EngineOptions.orchestration`, and the commit
  // path additionally returns at once without the injected `runGit` seam: absent seam = no git mutation.
  // -------------------------------------------------------------------------------------

  /** §2.5: the child's identity on the events the parent's surface reads. */
  private agentRef(): AgentRef {
    const o = this.opts.orchestration;
    return { slug: o?.slug ?? 'agent', runId: this.runId, sessionId: this.opts.session?.sessionId ?? null };
  }

  /**
   * §2.4 [G8]: after every `run` action in a child, diff the post-images against `own`. The paths outside it are
   * recorded on `StepRecord.escaped` and shown on the row; the step is NOT blocked, because the command already ran.
   *
   * [D2] review finding 1: the subtracted set is the STILL-CARRIED subset of `syncedDirty` (`carriedPaths`, inside the
   * facade's `outsideOwn`), never the raw list — subtracting the whole list would exempt up to 200 parent-dirty paths
   * from belt 2 for the whole run, including one a sibling rewrote.
   */
  private async noteEscaped(draft: StepDraft, changed: readonly string[]): Promise<void> {
    const o = this.opts.orchestration;
    if (o === undefined || o.depth !== 1 || draft.proposal?.action.kind !== 'run') return;
    // review 2026-09-22 finding 4: an empty `own` is NOT a reason to skip the diff — it is the case where
    // every changed path escaped. `escapedPaths` fails closed; this only skips when nothing changed at all.
    const own = o.own ?? [];
    if (changed.length === 0) return;
    try {
      const escaped = await escapedPaths(this.workspace.root, { changed, own, syncedDirty: o.syncedDirty ?? [] });
      if (escaped.length === 0) return;
      this.escapedThisStep = escaped;
      this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: escapedLine(escaped) });
    } catch (e) {
      this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `escape diff failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
    }
  }

  /**
   * §2.4 / corner row 18: three CONSECUTIVE belt-2 refusals park the child with `scope-fight` — "the honest signal
   * that the decomposition, not the worker, failed". A research refusal is not a scope fight (the split was fine; the
   * model asked for the wrong kind of action), so only `isOwnershipRefusal` reasons count.
   */
  private noteBeltRefusal(draft: StepDraft): string | null {
    if (this.opts.orchestration?.depth !== 1) return null;
    const o = draft.outcome;
    this.beltRefusals = o !== null && o.status === 'blocked' && isOwnershipRefusal(o.reason) ? this.beltRefusals + 1 : 0;
    if (this.beltRefusals < SCOPE_FIGHT_AFTER) return null;
    this.emit({
      type: 'transcript',
      step: draft.step,
      level: 'warn',
      text: `parked (scope-fight): ${SCOPE_FIGHT_AFTER} refusals in a row outside ${(this.opts.orchestration.own ?? []).join(', ')} — the split was wrong for this agent`,
    });
    return 'scope-fight';
  }

  /**
   * §2.6 [G1] [D2] [D10]: after every committed step of a child whose `outcome.status === 'executed'` and
   * `changedFiles.length > 0`. The add set is COMPUTED (`computeAddSet`), never `-A`: `git add -A` in an agent
   * worktree stages the parent's synced dirty set onto every branch from the first commit, which is what corner row
   * 55 exists to forbid.
   */
  private async commitAfterStep(draft: StepDraft): Promise<void> {
    const o = this.opts.orchestration;
    if (o === undefined || o.depth !== 1 || o.runGit === undefined) return;
    for (const p of draft.changedFiles) this.touchedPaths.add(p);
    if (draft.outcome?.status !== 'executed' || draft.changedFiles.length === 0) return;
    this.commitThisStep = await this.harnessCommit(draft.step, draft.proposal?.goal ?? summariseAction(draft.proposal?.action ?? { kind: 'done', summary: '' }));
  }

  /** §2.6: the one place the harness runs `git add` / `git commit`. `addSet` empty → no commit, no error. */
  private async harnessCommit(step: number, summary: string): Promise<string | null> {
    const o = this.opts.orchestration;
    const runGit = o?.runGit;
    if (o === undefined || runGit === undefined) return null;
    const dir = this.workspace.root;
    try {
      const { addSet } = await computeAddSet(runGit, dir, { touched: [...this.touchedPaths], syncedDirty: o.syncedDirty ?? [] });
      if (addSet.length === 0) return null;
      const r = await commitStep(runGit, dir, { addSet, identity: o.commit ?? DEFAULT_COMMIT_IDENTITY, slug: o.slug ?? 'agent', step, summary });
      if (!r.ok) {
        this.emit({ type: 'transcript', step, level: 'warn', text: `harness commit failed: ${this.redact(r.reason)}` });
        return null;
      }
      if (r.commit !== null) this.emit({ type: 'transcript', step, level: 'info', text: `committed ${r.commit.slice(0, 12)} in ${o.slug ?? 'agent'}` });
      return r.commit;
    } catch (e) {
      this.emit({ type: 'transcript', step, level: 'warn', text: `harness commit failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
      return null;
    }
  }

  /**
   * §2.6 / corner rows 36 and 37, INVERTED: uncommitted-at-end is the CRASH case. The end commit fires
   * unconditionally once when the add set is non-empty, so `addSet ≠ ∅` after a clean `run:end` means the process died
   * between the step commit and the git commit — and "uncommitted" means outside `carried ∪ syncedIgnored`, which is
   * exactly what `computeAddSet` computes.
   */
  private async commitAtEnd(): Promise<void> {
    const o = this.opts.orchestration;
    if (o === undefined || o.depth !== 1 || o.runGit === undefined) return;
    this.endCommit = await this.harnessCommit(this.step, 'run end');
  }

  /**
   * §2.5(c) / §4.2 P10: in a child the review confirm PARKS. The `ConfirmRequest` is written to
   * `<childRunDir>/orchestrate/review-<step>.json` (the store routes an `orchestrate/`-prefixed rel there), the parent's
   * surface is told through `agent:review`, and the confirm rejects with `AbortError('human_pause')` → rule-1 discard →
   * P10. Never returns.
   */
  private async parkForReview(draft: StepDraft, req: ConfirmRequest, why: string | null): Promise<never> {
    const write = this.store.writeCache;
    if (write !== undefined) {
      const body: Json = { ...(toJson(req) as JsonObject), ...(why !== null ? { reason: why } : {}) };
      try {
        await write.call(this.store, reviewCacheRel(draft.step), body);
      } catch (e) {
        this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `review park: ${reviewCacheRel(draft.step)} write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
      }
    }
    this.emit({ type: 'agent:review', agent: this.agentRef(), request: req });
    this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: false, aborted: true });
    this.emit({ type: 'transcript', step: draft.step, level: 'info', text: why !== null ? `review parked: ${why}` : `review parked: a human decision is needed (${reviewCacheRel(draft.step)})` });
    this.reviewParked = true;
    this.snapshotDraft(draft);
    throw new AbortError('human_pause');
  }

  /**
   * §2.5(c) / corner row 29: the answer file, `{ id, approved, note?, by, at }`, ID-MATCHED, SINGLE-USE and renamed to
   * `.used` on consumption. Anything else — missing, stale, id-mismatched, already used — answers `null`, which parks
   * again with `reason: 'answer not for this request'`. Nothing is ever auto-approved or auto-denied.
   */
  private async consumeReviewAnswer(req: ConfirmRequest): Promise<{ outcome: ConfirmOutcome } | { why: string }> {
    const rel = this.opts.orchestration?.reviewAnswerFile;
    if (rel === undefined) return { why: 'no answer file: a human decision is needed' };
    if (this.reviewAnswerUsed) return { why: 'answer not for this request' };
    const read = this.store.readCache;
    if (read === undefined) return { why: 'no answer file: a human decision is needed' };
    let raw: Json | null;
    try {
      raw = await read.call(this.store, rel);
    } catch {
      raw = null;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { why: 'answer not for this request' };
    const id = raw['id'];
    const approved = raw['approved'];
    if (typeof id !== 'string' || id !== req.id || typeof approved !== 'boolean') return { why: 'answer not for this request' };
    // single-use: consumed BEFORE it is answered from, so a crash between the two never re-serves it
    this.reviewAnswerUsed = true;
    const rename = this.store.renameCache;
    if (rename !== undefined) {
      try {
        await rename.call(this.store, rel, `${rel}.used`);
      } catch {
        // the answer is already consumed in memory; a failed rename must not re-approve anything
      }
    }
    const note = typeof raw['note'] === 'string' ? clip(sanitizeStream(raw['note']).replace(/\s+/g, ' ').trim(), REVIEWER_NOTE_MAX) : '';
    return { outcome: { approved, ...(note.length > 0 ? { note } : {}) } };
  }

  /**
   * §5.7 tail / corner row 44: the merge landed, so `RunMeta.landed` gains `{ step, branch, commit }` and
   * `RunMeta.undoUnavailableBelow` is set to the delegation step. `/undo` on that step then uses
   * `UndoSkipReason 'landed'` and offers `[g] git revert <commit>` as a NEW judged step (`landedUndoOffer`), and
   * `/rewind` below the floor is refused with `rewindRefusal`'s sentence.
   *
   * The `[c]` / `[s]` pre-flight steps are ordinary steps and are deliberately NOT recorded: they are undoable from
   * images like anything else, and only the merge is not.
   */
  private async noteLanded(draft: StepDraft, outcome: ActionOutcome): Promise<void> {
    const pending = this.pendingLand;
    const runGit = this.opts.orchestration?.runGit;
    const action = draft.proposal?.action;
    if (pending === null || runGit === undefined || outcome.status !== 'executed') return;
    if (action?.kind !== 'run' || !/^git\s+merge\s/.test(action.command)) return;
    this.pendingLand = null;
    let commit = '';
    try {
      const r = await runGit(this.workspace.root, ['rev-parse', 'HEAD']);
      commit = r.ok ? r.stdout.trim() : '';
    } catch {
      commit = '';
    }
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return;
    const landed = [...this.landedMerges, { step: draft.step, branch: pending.branch, commit }];
    this.landedMerges = landed;
    const floor = pending.delegatedAt;
    try {
      await this.store.updateMeta({ landed, undoUnavailableBelow: floor });
    } catch (e) {
      this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `${CHECKPOINT_FILES.meta} write failed (landed): ${e instanceof Error ? this.redact(e.message) : String(e)}` });
    }
    this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `landed ${pending.agents} ${pending.agents === 1 ? 'agent' : 'agents'} from ${pending.branch} as ${commit.slice(0, 12)} — /undo offers [g] git revert ${commit.slice(0, 12)}; /rewind below step ${floor} is refused` });
  }

  /**
   * §5.7: the seeded proposal of the launch step. It enters the loop through the SAME path a replayed proposal takes,
   * so it goes through `risk`, the review confirm, `takePreImages`, `execute`, `takePostImages` and `judge` exactly
   * like any other step — the transcript, `--json`, the decisions pane and `/diff` then all fall out for free.
   */
  private takeSeeded(step: number): StepCache | null {
    const s = this.seededStep;
    if (s === null || s.step !== step) return null;
    this.seededStep = null;
    this.emit({ type: 'transcript', step, level: 'info', text: s.note });
    return {
      v: 1,
      step,
      stage: 'propose',
      proposal: s.proposal,
      patchTargets: [],
      risk: null,
      matchesIntent: null,
      intent: null,
      proposer: null,
      contextFiles: [],
      directive: null,
      targets: [],
      partial: null,
      llmRound: null,
      resumes: this.resumes,
      at: nowIso(),
    };
  }

  /** §5.7: seed the NEXT step's proposal. False when the run has finished or a seed is already pending. */
  seedStep(proposal: Proposal, note?: string): boolean {
    if (this.finishing || this.isFinished() || this.seededStep !== null) return false;
    // docs/AGENT-LOOP-DESIGN.md §2.2: the driver proposes every agent step, so a seeded proposal would never run — refused, said once
    if (this.mode === 'agent') {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: AGENT_SEEDED_STEP_REFUSED });
      return false;
    }
    this.seededStep = { step: this.step + 1, proposal, note: note ?? `step ${this.step + 1}: proposal seeded by the harness (${summariseAction(proposal.action)})` };
    return true;
  }

  /**
   * §5.7 + [D1]: the launch. `overlap` empty → the merge is seeded exactly as written. `overlap` non-empty → **no merge
   * action is proposed at all**; the `land-preflight` pane offers `[c]` / `[s]` / `[x]`, each of which is itself an
   * ordinary judged step, and `[c]` / `[s]` re-run the pre-flight and seed the merge as a SECOND judged step.
   */
  async land(input: LaunchInput, ask?: (offer: LandPreflightOffer) => Promise<BlockingAnswer>): Promise<{ seeded: 'merge' | 'commit' | 'stash' | 'stop' | null; overlap: string[] }> {
    const o = this.opts.orchestration;
    const runGit = o?.runGit;
    if (runGit === undefined) return { seeded: null, overlap: [] };
    // docs/AGENT-LOOP-DESIGN.md §2.2: /land's merge and pre-flight steps are seeded steps, which agent mode does not run — refuse
    // before any git read, so nothing is committed or stashed for a merge that would never happen
    if (this.mode === 'agent') {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: AGENT_SEEDED_STEP_REFUSED });
      return { seeded: null, overlap: [] };
    }
    const { overlap, ok } = await launchOverlap(runGit, input);
    const plan: PlanDraft = { done: this.plan.done.map((d) => d.text), remaining: [...this.plan.remaining], openProblems: [...this.plan.openProblems] };
    // review 2026-09-22 finding 1: `!ok` is its OWN case. `launchOverlap` reports `ok: false` when
    // `statusEntries` failed, and its `overlap` is then `[]` — which is indistinguishable from "your checkout is
    // clean" and used to fall through to the offer branch, where an empty pathspec made `[s]` mean "stash your
    // entire working tree". We cannot read the checkout, so we cannot say what overlaps: refuse, seed nothing.
    if (!ok) {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `/land: could not read your checkout (git status failed): nothing was committed or stashed — ${input.dockBranch} stays and /diff still works` });
      return { seeded: null, overlap: [] };
    }
    if (overlap.length === 0) {
      this.pendingLand = { branch: input.dockBranch, agents: input.agents, delegatedAt: input.delegationStep ?? this.step + 1 };
      this.seedStep(launchProposal(mergeAction(input.pinned), `land ${input.agents} agents: merge ${input.dockBranch}`, plan), `step ${this.step + 1}: landing ${input.agents} agents — ${input.dockBranch} merges as an ordinary judged step`);
      return { seeded: 'merge', overlap: [] };
    }
    // [D1] NO merge action is proposed: `git merge` would abort with `Your local changes … would be overwritten by merge`
    const offer = landPreflightOffer(this.nextBlockingId(), this.step + 1, overlap, input);
    this.emit({ type: 'transcript', step: null, level: 'warn', text: `/land: ${offer.detail}` });
    const answer = ask === undefined ? 'stop' : await ask(offer).catch(() => 'stop' as const);
    const chosen: LaunchAnswer = answer === 'commit' || answer === 'stash' ? answer : 'stop';
    const seeded = seedFor(chosen, overlap, input, plan);
    if (seeded === null) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `/land cancelled: ${input.dockBranch} stays and /diff still works` });
      return { seeded: null, overlap };
    }
    this.pendingLand = { branch: input.dockBranch, agents: input.agents, delegatedAt: input.delegationStep ?? this.step + 1 };
    this.seedStep(seeded, `step ${this.step + 1}: ${chosen === 'commit' ? 'committing' : 'stashing'} ${overlap.length} overlapping file(s) before the merge`);
    return { seeded: chosen, overlap };
  }

  private flushGeneratorRecords(draft: StepDraft): void {
    for (const rec of draft.generatorRecords) this.persist(this.store.appendGenerator(rec), 'generator.jsonl');
    draft.generatorRecords = [];
  }

  private absorbDiscardedTiming(draft: StepDraft): void {
    // contract 1.4 (W2b), §4.3 step 7: a discarded step's lease is released `discarded` at once. Without this a
    // rule-1 discard would leave an `exclusive` lease live for its full ttl and every peer would wait on a step that
    // is never going to run.
    this.coord?.released('discarded');
    // contract 1.9 (Fastlane) §2.6 / §7.5 seam (c): the ATTEMPT is over — its token is invalidated, so a router
    // answering after the discard applies to nothing and its ledger goes nowhere (no `StepRecord` is written for
    // a discarded step). The key stays open, because §7.3 step 3 replays this same step number and a closed key
    // would drop every router of the replayed attempt `committed`.
    if (routersOn(this.mode, this.opts.routers)) discardStepRouters(this.runId, draft.step);
    // Discarded steps (§9.1 rule 1) still consumed wall time and money; the run totals keep them.
    // contract 1.4 (§7.2, §11 row 41): this attempt's sample rows (flushed now, or landing late) carry `discarded: true`
    draft.discarded = true;
    for (const rec of draft.generatorRecords) rec.discarded = true;
    this.flushGeneratorRecords(draft);
    // §4.8: a sample of this step that ends from here on writes its row itself (pushGeneratorRecord)
    draft.closed = true;
    if (this.replayCache !== null && this.replayCache.step === draft.step) this.replayCache = null;
    const total = Math.max(0, this.clock() - draft.t0);
    this.timing.generatorMs += draft.timing.generatorMs;
    this.timing.jevMs += draft.timing.jevMs;
    this.timing.execMs += draft.timing.execMs;
    this.timing.totalMs += total;
    // contract 1.5 (§4.1 [D13]): a discarded step still paid for its decomposition (corner row 8)
    if (draft.timing.decomposeMs > 0) this.timing.decomposeMs = (this.timing.decomposeMs ?? 0) + draft.timing.decomposeMs;
    // F13 (finishing pass): and for its coordinate gate and its fast-path round, which were short the same way as
    // the commit path. The attempt really spent this wall — §9.1 rule 1 replays the step NUMBER with a fresh draft,
    // so nothing here is counted twice — and each stays absent when the discarded attempt never reached it.
    //
    // Review defect A9: this is the one place `RunResult.timing` exceeds the sum of the `steps.jsonl` rows, and
    // it does so by design — no `StepRecord` is written for a discarded attempt (see just above), so its wall
    // has nowhere else to be recorded. The two doc comments that claimed "the sum of the rows" now say so.
    if (draft.timing.coordinateMs > 0) this.timing.coordinateMs = (this.timing.coordinateMs ?? 0) + draft.timing.coordinateMs;
    if (draft.timing.coordWaitMs > 0) this.timing.coordWaitMs = (this.timing.coordWaitMs ?? 0) + draft.timing.coordWaitMs;
    if (draft.fastPathMs > 0) this.timing.fastPathMs = (this.timing.fastPathMs ?? 0) + draft.fastPathMs;
    if (draft.fastPathJevMs > 0) this.timing.fastPathJevMs = (this.timing.fastPathJevMs ?? 0) + draft.fastPathJevMs;
    if (this.mode === 'llm-jev') {
      const t = this.llmJevTiming(draft, total);
      this.timing.harnessMs += t.harnessMs;
      this.timing.synthMs = (this.timing.synthMs ?? 0) + (t.synthMs ?? 0);
    } else {
      this.timing.harnessMs += Math.max(0, total - draft.timing.generatorMs - jevChargedMs(draft) - draft.timing.execMs - draft.timing.confirmMs - draft.timing.coordWaitMs);
    }
  }

  /**
   * docs/LLM-JEV-DESIGN.md §7.5 (llm-jev): `synthMs` = wall of synthesize(); `harnessMs` = total − synthMs − execMs − confirmMs −
   * the shell's Jev latency (requests outside the synthesizer). The generator batch wall and the synthesizer's Jev requests sit
   * inside synthMs and are reported in their own buckets without being subtracted again.
   */
  private llmJevTiming(draft: StepDraft, total: number): StepTiming {
    const synthMs = draft.synthMs ?? 0;
    // the shell's Jev share, charged at the larger of reported latency and measured wall (see StepDraft.timing)
    const shellJevMs = Math.max(Math.max(0, draft.timing.jevMs - draft.synthJevMs), Math.max(0, draft.timing.jevWallMs - draft.synthJevWallMs));
    return {
      generatorMs: draft.timing.generatorMs,
      jevMs: draft.timing.jevMs,
      execMs: draft.timing.execMs,
      harnessMs: Math.max(0, total - synthMs - draft.timing.execMs - draft.timing.confirmMs - draft.timing.coordWaitMs - shellJevMs),
      totalMs: total,
      synthMs,
      // review defect A10: the SAME optional-bucket builder the commit path uses. It used to be an inline list
      // here, and it was already two members short (`fastPathMs`, `fastPathJevMs`) — which
      // `absorbDiscardedTiming` reads for both branches, so a discarded llm-jev attempt could contribute
      // fast-path wall to the run that a committed one could not.
      ...optionalStepTiming(optionalTimingInput(draft)),
    };
  }

  /** The stop rule after a step: llm-jev → the code fact of docs/LLM-JEV-DESIGN.md §6.6; jev-on / jev-only → `task_complete >= completeThreshold`. */
  private completeAfter(draft: StepDraft): boolean {
    // docs/AGENT-LOOP-DESIGN.md §3.3 / §8: the final answer on a current, green run of the unscoped detected test command
    // (never for a reply: a run with no tool call verified nothing, whatever `lastTestRun` says — §A1's `answered` wins)
    if (this.mode === 'agent') return draft.proposal?.action.kind === 'done' && draft.outcome?.status === 'noop' && !isReplyOnlyRun(this.agentSteps) && this.agentVerifiedCompletion();
    if (this.mode === 'llm-jev') return isCompleteByFact(this.completionFact(draft));
    if (!usesJev(this.mode)) return false;
    // contract 1.9 (Fastlane) §2.5 RL5 / §7.5 seam (d): with the routers ON, completion is demoted to
    // recorded-only on exactly the steps where the harness holds the fact itself — a step whose proposal carries
    // `ProposalEvidence`, which in `jev-on` is ZERO steps until route R9 commits its first fast-path proposal.
    // Off that, and on every routers-off run, this is the pre-1.9 line and `completionDecision` is not consulted
    // at all: the call is behind the same one `if` the rest of the wave is (I2, `router-golden.test.ts`).
    if (!routersOn(this.mode, this.opts.routers)) return isComplete(draft.completion, this.opts.limits.completeThreshold);
    const fact = this.completionFact(draft);
    return completionDecision({ routers: true, hasEvidence: draft.proposal?.evidence !== undefined, completion: draft.completion, threshold: this.opts.limits.completeThreshold, fact }).complete;
  }

  private completionFact(draft: StepDraft): CompletionFactInput {
    const proposal = draft.proposal;
    const judged = draft.judge?.tests;
    return {
      action: proposal?.action.kind ?? null,
      outcome: draft.outcome?.status ?? null,
      tests: draft.tests,
      // §6.6 `workspace.testsCurrent` on the claiming run itself: no change was executed at or after it (commit() has already
      // folded this step into lastChangeStep, which a `run` never sets)
      testsCurrent: this.lastChangeStep === null || this.lastChangeStep < draft.step,
      completion: proposal?.evidence?.completion,
      // the recorded `tests_pass_unparsed` stands in only when the parser read nothing (judge-code.ts codeJudge)
      testsPassUnparsed: judged && judged.source === 'judged' ? judged.allPassed : null,
      verifiedDone: proposal !== null && this.verifiedCompletion(proposal) !== null,
    };
  }

  private async confirm(draft: StepDraft, proposal: Proposal, risk: RiskAssessment): Promise<ConfirmOutcome> {
    // TUI-DESIGN §15 item 6: matches_intent (row 8 of the review box) and the risk stage's Jev latency (120-column title), spread in only when known
    const riskRequests = draft.jevRequests.filter((r) => r.stage === 'risk');
    const req: ConfirmRequest = {
      id: `${this.runId}:${draft.step}`,
      step: draft.step,
      proposal,
      risk,
      ...(draft.matchesIntent !== null ? { matchesIntent: draft.matchesIntent } : {}),
      ...(riskRequests.length > 0 ? { jevLatencyMs: riskRequests.reduce((n, r) => n + r.latencyMs, 0) } : {}),
    };
    this.emit({ type: 'confirm:request', request: req });
    // ORCHESTRATION-DESIGN §2.5(c) / §4.2 P10: a child never blocks a human on an interactive confirmer it does not
    // have. It answers ONCE from the parent's id-matched, single-use answer file, or it parks at P10.
    if (this.opts.orchestration?.depth === 1) {
      const answered = await this.consumeReviewAnswer(req);
      if ('outcome' in answered) {
        this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: answered.outcome.approved, aborted: false, ...(answered.outcome.note !== undefined ? { note: answered.outcome.note } : {}) });
        return answered.outcome;
      }
      await this.parkForReview(draft, req, answered.why);
    }
    const c0 = this.clock();
    try {
      const c = this.opts.confirmer;
      // TUI-DESIGN §15.2 confirm() row: confirmDetailed preferred when present (the TUI's `d` note); confirm() stays the fallback
      const r: ConfirmOutcome = c.confirmDetailed ? await c.confirmDetailed(req, { signal: this.signal }) : { approved: await c.confirm(req, { signal: this.signal }) };
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      const rawNote = typeof r.note === 'string' ? clip(sanitizeStream(r.note).replace(/\s+/g, ' ').trim(), REVIEWER_NOTE_MAX) : '';
      const note = rawNote.length > 0 ? rawNote : undefined;
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: r.approved, aborted: false, ...(note !== undefined ? { note } : {}) });
      return { approved: r.approved, ...(note !== undefined ? { note } : {}) };
    } catch (e) {
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: false, aborted: true });
      // A confirmer abort without an engine abort (renderer-side Ctrl-C) is a human abort.
      if (isAbortError(e) && !this.signal.aborted) this.abort(e.reason === 'signal' ? 'signal' : 'human_abort');
      throw e;
    }
  }

  /**
   * Fix 1 (experiments/results/jev-only-ladder-4-analysis.md §4): a `done` whose plan claims nothing
   * remains while the engine's own last test run passed everything and no file changed since is
   * completion the harness verified, so the risk stage does not refuse it; the completion Noul still
   * decides the stop. The accepted plan's `remaining` is Jev's bookkeeping (a refused `done`'s claims
   * are rejected, so its `verify …` item lags the green run) and is deliberately not a condition.
   */
  private verifiedCompletion(proposal: Proposal): VerifiedCompletion | null {
    if (proposal.action.kind !== 'done' || proposal.plan.remaining.length > 0) return null;
    const run = this.lastTestRun;
    if (run === null || !run.allPassed || !testsCurrent(run, this.lastChangeStep)) return null;
    return { command: run.command, step: run.step };
  }

  /**
   * DESIGN §5.5 / JEV-ONLY-DESIGN §5.5 exit as a code rule (Fix 3): three refused `done`s with one
   * signature reach replan; when Jev answers `gather_context` a second time for that same signature
   * (the synthesizer already had nothing to gather), the directive is treated as `stop_and_report`.
   */
  private repeatedGatherContextExit(directive: ReplanDirective): string | null {
    const sig = this.detector.trippedSignature();
    if (sig === null || signatureKind(sig) !== 'done' || directive.move !== 'gather_context') return null;
    const prior = this.detector.priorDirectives(sig).filter((d) => directiveMove(d.directive) === 'gather_context');
    if (prior.length === 0) return null;
    return `gather_context directed again for ${sig} (already directed at step ${prior.map((d) => d.step).join(', ')})`;
  }

  private commonState(changedFiles: readonly string[], recent: readonly WindowEntry[], draft?: StepDraft): JsonObject {
    const snap = this.opts.meter.snapshot();
    // In the judge state lastTestRun/lastChangeStep already include this step's executed action (§5.5).
    let lastTestRun = this.lastTestRun;
    let lastChangeStep = this.lastChangeStep;
    if (draft?.tests?.parsed) lastTestRun = { step: draft.step, command: draft.tests.command, passed: draft.tests.parsed.passed, failed: draft.tests.parsed.failed, errors: draft.tests.parsed.errors, allPassed: draft.tests.allPassed === true };
    if (draft && draft.outcome?.status === 'executed' && draft.changedFiles.length > 0 && draft.proposal && draft.proposal.action.kind !== 'run' && draft.proposal.action.kind !== 'read') lastChangeStep = draft.step;
    return buildCommonState({
      task: this.opts.task,
      plan: this.plan,
      recent,
      workspace: {
        root: this.workspace.root,
        git: this.wsInfo.git,
        hasTests: this.wsInfo.hasTests,
        testCommand: this.wsInfo.testCommand?.command ?? null,
        changedFiles,
        createdThisRun: [...this.createdThisRun, ...(draft?.created ?? [])],
        lastChangeStep,
        lastTestRun,
        sandbox: this.sandbox.level,
      },
      budget: { stepsUsed: this.step, stepsMax: this.opts.limits.maxSteps, spentUsd: snap.totalUsd, capUsd: snap.capUsd },
      redact: this.redact,
      // TUI-DESIGN §8.6: the directives applied to this step reach intent, context, risk and judge (P1: Jev sees them)
      human: this.activeHuman?.step === (draft?.step ?? this.step + 1) ? { directives: this.activeHuman.texts, step: this.activeHuman.step } : null,
    });
  }

  private promptInput(draft: StepDraft, changedFiles: string[], contextFiles: PromptInput['contextFiles'], candidates: PromptInput['candidates']): PromptInput {
    const hints: PromptHints = { ...this.nextHints };
    this.nextHints = {};
    if (draft.intent && draft.intent.planStillValid < PLAN_STALE_THRESHOLD) hints.planStale = { probability: draft.intent.planStillValid };
    const loopNotice = this.pendingLoopNotice;
    this.pendingLoopNotice = null;
    const resumed = this.firstStepAfterResume;
    this.firstStepAfterResume = false;
    return {
      mode: this.mode,
      step: draft.step,
      task: this.opts.task,
      plan: this.plan,
      intent: draft.intent ? { intent: draft.intent.intent, answer: draft.intent.answer, probability: draft.intent.probability, pairedNoul: draft.intent.pairedNoul, verdict: draft.intent.verdict } : null,
      hints,
      directive: draft.directive,
      loopNotice,
      window: this.window,
      workspace: { changedFiles, resumed, testCommand: this.wsInfo.testCommand?.command ?? null, git: this.wsInfo.git },
      contextFiles,
      candidates,
      toolName: 'propose_action',
      // contract 1.9 (Fastlane) §3.3 (F25): the byte-stable prefix — task -> repo map -> files -> everything
      // volatile -> window. Nothing is added, removed or rewritten; only the order changes, and only under the S2
      // switch, which is `jev-on` only and off by default. That default is what keeps `router-golden.test.ts` and
      // every `view: 'legacy'` prompt golden valid without a re-capture.
      ...(this.s2 === 'off' ? {} : { prefixOrder: 'pinned' as const }),
      // TUI-DESIGN §8.6: one hints line per directive for exactly this step; §15 item 11: the @-mentioned files
      humanDirectives: this.activeHuman?.step === draft.step ? [...this.activeHuman.texts] : [],
      pinnedFiles: [...(this.opts.seed?.pinnedFiles ?? [])],
    };
  }

  // -------------------------------------------------------------------------------------
  // docs/COORDINATION-DESIGN.md §8: the generator's relaxed context (history, files in view, compaction, meter)
  // -------------------------------------------------------------------------------------

  /**
   * The optional CheckpointState fields (§8.3, §8.4, §8.6, §12.0.3), each present only when it carries something.
   *
   * F26 widens the return past `ContextCheckpointExtension` by `kept` alone: that `Pick` lives in
   * `src/checkpoint/types.ts` beside `readContextExtension`, which is a different owner's file, and `kept` is
   * validated on the way in by `readKeptItems` (`context/kept.ts`) instead. The member itself is
   * `CheckpointState['kept']`, so nothing here is a second declaration.
   */
  private contextExtension(): ContextCheckpointExtension & Pick<CheckpointState, 'kept'> {
    const ext: ContextCheckpointExtension & Pick<CheckpointState, 'kept'> = {};
    if (this.history.length > 0) ext.history = this.history.map((e) => ({ ...e, shownFiles: [...e.shownFiles], notes: [...e.notes] }));
    if (this.fileCache.length > 0) ext.fileCache = this.fileCache.map((e) => ({ ...e }));
    if (Object.keys(this.fileMemory).length > 0) ext.fileMemory = { ...this.fileMemory };
    if (this.summaryAt !== null) ext.summaryAt = this.summaryAt;
    // §8.6 (F26): absent until the first compaction extracted something, so a run that never compacts (and every
    // run written before the extractor existed) carries the same object it always did
    if (this.kept.length > 0) ext.kept = this.kept.map((k) => ({ ...k }));
    if (this.compactions > 0) ext.compactions = this.compactions;
    if (this.lastCompactionAt !== null) ext.lastCompactionAt = this.lastCompactionAt;
    return ext;
  }

  /** §8 / §12.0.3: the relaxed view (fresh files, planned history), then the prompt, then the meter — all before the call. */
  private async proposeWithContext(ctx: StageContext, draft: StepDraft, changedFiles: string[], contextFiles: PromptInput['contextFiles'], candidates: PromptInput['candidates']): Promise<ProposeStageResult> {
    const base = this.promptInput(draft, changedFiles, contextFiles, candidates);
    // review finding 28 / D5: the legacy pin and the non-consuming modes send HEAD's message, byte for byte — the hook only
    // counts its chars (contract 1.4 `lastPromptChars`); no meter, no file view, no compaction runs on this path
    if (!this.contextEnabled) return runProposeStage(ctx, this.systemPrompt, base, { onPrompt: (built) => this.notePromptChars(built) });
    const t0 = this.clock();
    const prompt: PromptInput = { ...base, context: await this.contextView(draft.step) };
    return runProposeStage(ctx, this.systemPrompt, prompt, { onPrompt: (built) => this.notePromptBuilt(built, draft.step, t0) });
  }

  /**
   * contract 1.4 (§8.8 column 3, §12.0.3) / TUI-DESIGN-5 §8.2 R13: `SynthesisContext.contextText` for the llm-jev
   * synth propose stage — the same three beats as `proposeWithContext()` above, in the same order: build the view
   * (`contextView(step)`, which is also where a pending resume compaction fires), build the message with the SAME
   * `buildPrompt`, then `notePromptBuilt` — so `ContextUsage` is recomputed here exactly as it is on the jev-on path,
   * a `context:warn` crossing is emitted from the one place that emits it, and the 85 % trigger the step's commit
   * reads sees this step's real percentage. §12.0.3 names this cadence point: "in `jev-only` / `llm-jev` after
   * `SynthesisContext.contextText` is assembled".
   *
   * Undefined — and NOTHING built, so not a byte of §8 weight — whenever this run has no relaxed view: `jev-only`
   * (no generator) and `view: 'legacy'` both leave `contextEnabled` false and the synthesizer prompts as it did.
   */
  private async synthContextText(draft: StepDraft, changedFiles: string[]): Promise<string | undefined> {
    if (!this.contextEnabled) return undefined;
    const t0 = this.clock();
    const base = this.promptInput(draft, changedFiles, [], null);
    const built = buildPrompt({ ...base, context: await this.contextView(draft.step) });
    this.notePromptBuilt(built, draft.step, t0);
    return synthContextText(built.text);
  }

  /** The rolling summary, read from the run dir once per process (a resume starts with `summaryAt` but no text). */
  private async ensureSummaryLoaded(): Promise<void> {
    if (this.contextLoaded) return;
    this.contextLoaded = true;
    if (!hasContextStore(this.store) || this.summaryAt === null || this.summary !== null) return;
    const raw = await this.store.readContextSummary().catch(() => null);
    if (isContextSummary(raw)) this.summary = raw;
  }

  /**
   * §8.2(a) / §8.3: open ONLY the output files the plan's surviving tiers will show — the fit was computed from
   * `fullOutputChars` before any read, so a tier the 30 % allowance cannot show is never opened (review D11). Warm steps
   * read nothing: the views are memoised for the life of the process.
   */
  private async loadPlannedOutputs(plan: HistoryPlan): Promise<void> {
    if (!hasContextStore(this.store)) return;
    for (const step of plan.reads) {
      if (this.outputViews.has(step) || this.missingOutputs.has(step)) continue;
      const text = await this.store.readOutput(step).catch(() => null);
      // §8.5 / review finding 22: a resume whose run dir was mirrored without `outputs/` must not print a pointer at nothing
      if (text === null) this.missingOutputs.add(step);
      else this.outputViews.set(step, outputView(text));
    }
  }

  /** §8.3 / §8.4: what the prompt shows this step — one stat per cached file, a read only where a stat changed, memoised output views. */
  private async contextView(step: number): Promise<PromptContextView> {
    await this.ensureSummaryLoaded();
    // §8.6: the resume trigger runs before the first prompt of the resumed process, never mid-step
    if (this.pendingResumeCompaction) {
      this.pendingResumeCompaction = false;
      const trigger = compactionDue({ step: this.step, compactEvery: this.contextPolicy.compactEvery, pct: 0, mode: this.contextPolicy.compaction, foldable: foldableCount(this.history), resume: true });
      if (trigger !== null) this.compactContext(this.step, trigger);
    }
    await this.rankKeptItems(step);
    const refreshed = await this.filesInView.refresh(this.fileCache, step, this.contextPolicy.fileCacheBytes);
    this.lastRefreshMs = refreshed.ms;
    if (refreshed.failed.length > 0) {
      for (const f of refreshed.failed) this.fileCache = dropFile(this.fileCache, f.rel);
      // review D16: paths and error text are redacted like every other transcript line
      const gone = refreshed.failed.map((f) => f.rel).join(', ');
      this.emit({ type: 'transcript', step, level: 'info', text: this.redact(`files in view: dropped ${gone} (${clip(refreshed.failed[0]!.reason, 120)})`) });
    }
    this.fileCache = noteShown(this.fileCache, new Map(refreshed.files.map((f) => [f.rel, f.shownChars] as const)));
    // §8.2(a): plan first (pure, from `fullOutputChars`), read only what survives, then render
    const plan = planHistory(this.history, Math.floor(this.contextPolicy.budgetChars * HISTORY_SHARE));
    await this.loadPlannedOutputs(plan);
    this.lastRecentSteps = { chars: plan.chars, allowanceChars: plan.allowanceChars, whole: plan.whole, clipped: plan.clipped, oneLine: plan.oneLine, reads: plan.reads.length };
    // contract 1.6 (IMPORT-DESIGN §2.10.4): the step's paths are its files in view plus the @-mentioned pins, the same
    // set §8.2 uses; `selectMemory` is empty (and both sections elide) whenever the run was given no memory
    const memory = selectMemory(this.opts.memory, [...refreshed.files.map((f) => f.rel), ...(this.opts.seed?.pinnedFiles ?? [])]);
    // contract 1.4 (COORDINATION-DESIGN §8.8 / §9): the last gate's facts fill `## Other sessions` for the NEXT
    // prompt. `currentFacts()` is null before the first `coordinate` stage and the whole member is ABSENT when
    // coordination is off or nothing is live, which is what keeps a non-coordinating run's prompt byte-identical.
    const coordFacts = this.coord?.currentFacts() ?? null;
    const sessions = coordFacts !== null && (coordFacts.others > 0 || coordFacts.conflicts.length > 0 || coordFacts.requested.length > 0 || coordFacts.messages.length > 0) ? coordFacts : null;
    return {
      ...(sessions === null ? {} : { coordination: sessions }),
      // §8.6 fourth bullet (F26, the finishing pass): the extracted items reach the prompt's
      // `## Kept (do not re-derive)`. Until this line nothing filled `PromptContextView.kept`, so the extractor,
      // the `context.kept` switch and `CheckpointState.kept` were a mechanism with no consumer — the section
      // rendered for nobody. ABSENT while the list is empty (every run before its first compaction, and every
      // run that never compacts), so `keptSection` elides exactly as it did and no relaxed prompt moves until
      // there is something to say. `view: 'legacy'` never reaches this method at all.
      ...(this.kept.length > 0 ? { kept: this.kept.map((k) => ({ ...k })) } : {}),
      ...(memory.rules.length > 0 ? { rulesInScope: memory.rules } : {}),
      ...(memory.topics.length > 0 ? { memoryInScope: memory.topics } : {}),
      files: refreshed.files.map((f) => ({
        path: f.rel,
        content: f.content,
        bytes: f.bytes,
        truncatedBytes: f.truncatedBytes,
        windowStart: f.windowStart,
        lineFrom: f.lineFrom,
        lineTo: f.lineTo,
        lineTotal: f.lineTotal,
        pinnedBy: f.pinnedBy,
        lastUsedStep: f.lastUsedStep,
        omitted: f.omitted,
      })),
      history: renderHistory(plan, { view: (n) => this.outputViews.get(n) ?? null, missing: (n) => this.missingOutputs.has(n) }),
      summary: this.summary?.text ?? null,
      summaryAt: this.summaryAt,
      budgetChars: this.contextPolicy.budgetChars,
      newestClipped: plan.newestClipped,
    };
  }

  /**
   * §12.0.3 cadence point 1: the meter once the step's prompt is built, before the generator call. Review D2: the
   * zero-cost read may only stand on the files this message really rendered whole. Review D15: the meter counts the
   * WHOLE prompt — the system prompt goes to the model on every call too.
   */
  private notePromptBuilt(built: PromptBuild, step: number, startedAt?: number): void {
    this.filesInView.keepShown(built.shownFiles);
    if (startedAt !== undefined) this.lastPromptBuildMs = Math.max(0, this.clock() - startedAt);
    this.notePromptChars(built);
    // contract 1.6 (§2.10.3): what the two memory sections cost this build; null on a run with no memory
    this.lastMemoryBuild = built.memory ?? null;
    const before = this.contextUsage.pct;
    this.contextUsage = this.usage(this.systemPrompt.length + built.chars);
    // contract 1.4 (Q16): one `context:warn` per UPWARD crossing of the §8.6 line. Only this branch runs it, so `legacy`
    // and the non-consuming modes never emit; the fold at the commit below lowers the meter and re-arms the next one.
    const u = this.contextUsage;
    if (contextWarnCrossed(before, u.pct)) this.emit({ type: 'context:warn', step, pct: u.pct, budgetTokens: u.budgetTokens, tokensInWindow: u.tokensInWindow });
  }

  /**
   * contract 1.4 (§12.0.3): `CheckpointState.lastPromptChars` — the chars of the last generator prompt this run built
   * (system + message), the same quantity `ContextUsage.promptChars` reports, so a resumed process's meter starts from a
   * fact instead of 0. Recorded for every generator prompt, relaxed view or legacy.
   */
  private notePromptChars(built: PromptBuild): void {
    this.lastPromptChars = this.systemPrompt.length + built.chars;
  }

  /** One place where `ContextUsage` is assembled, so both cadence points report the same members (§12.0.3). */
  private usage(promptChars: number, over: { summaryAt?: number; lastCompactionAt?: string } = {}): ContextUsage {
    const summaryAt = over.summaryAt ?? this.summaryAt;
    return computeContextUsage({
      promptChars,
      budgetChars: this.contextPolicy.budgetChars,
      budget: this.contextPolicy.budget,
      recentSteps: this.lastRecentSteps,
      promptBuildMs: this.lastPromptBuildMs,
      refreshMs: this.lastRefreshMs,
      files: this.fileCache.length,
      historyEntries: this.history.length,
      summaryAt,
      lastCompactionStep: summaryAt,
      compactions: this.compactions,
      lastCompactionAt: over.lastCompactionAt ?? this.lastCompactionAt,
      compaction: this.contextPolicy.compaction,
      // contract 1.6 (§2.10.3): omitted — and so omitted from ContextUsage — on a run with no memory
      ...(this.lastMemoryBuild === null ? {} : { memory: { indexChars: this.memoryIndexChars, ...this.lastMemoryBuild } }),
    });
  }

  /** §8.3 / §8.4: the execute stage's `read` hooks — the zero-cost read (one stat) and the `jevcode:outputs/step-<n>.txt` pseudo-path. */
  private contextReadHooks(): ContextReadHooks {
    return {
      unchanged: async (rel) => (this.contextEnabled ? ((await this.filesInView.unchanged(rel, this.fileMemory))?.text ?? null) : null),
      nextWindow: async (rel) => (this.contextEnabled ? ((await this.filesInView.nextWindow(rel, this.step + 1))?.text ?? null) : null),
      runOutput: async (pathOrRef) => {
        const step = parseOutputRef(pathOrRef);
        if (step === null) return null;
        const stored = hasContextStore(this.store) ? await this.store.readOutput(step).catch(() => null) : null;
        if (stored !== null) return stored;
        // the file is gone (the 64 MiB bound, or a mirror without `outputs/`): the memoised head + tail is still the truth
        this.missingOutputs.add(step);
        const view = this.outputViews.get(step);
        return view === undefined ? null : tierText(view, HISTORY_WHOLE_HEAD, HISTORY_WHOLE_TAIL, null);
      },
    };
  }

  /** The §8 bookkeeping at commit: the history entry (+ the whole output on disk), files in view, fileMemory, eviction, compaction. */
  private commitContext(draft: StepDraft, entry: WindowEntry, step: number): void {
    if (!this.contextEnabled) return;
    // review D22: the prompt must show the SAME bytes in-process as after a resume — memoise the redacted text, which is
    // exactly what `writeOutput` puts on disk
    const output = draft.output.length > 0 ? this.redact(draft.output) : null;
    let ref: string | null = null;
    if (needsOutputFile(output) && hasContextStore(this.store)) {
      // §8.3 / §8.5: the whole text is on disk before any clip names it; the write rides the outputs/ chain, never the step
      ref = outputRefFor(step);
      const written = this.store.writeOutput(step, output);
      // review D12: the per-run 64 MiB bound may delete older files — mark those entries so their pointer is not printed again
      this.persist(
        written.then((evicted) => {
          if (evicted.length > 0) this.noteOutputsEvicted(evicted);
        }),
        `${CHECKPOINT_FILES.outputs}/${outputFileName(step)}`,
      );
    }
    if (output !== null) {
      this.outputViews.set(step, outputView(output));
      const excess = this.outputViews.size - HISTORY_MID;
      if (excess > 0) for (const s of [...this.outputViews.keys()].sort((a, b) => a - b).slice(0, excess)) this.outputViews.delete(s);
    }
    this.history = pushHistory(this.history, buildHistoryEntry(entry, output, ref), this.contextPolicy.historySteps);

    const proposal = draft.proposal;
    if (proposal !== null && draft.outcome?.status === 'executed') {
      const a = proposal.action;
      if (a.kind === 'read') {
        for (const p of a.paths) {
          if (p.startsWith(OUTPUT_READ_PREFIX)) continue;
          this.fileCache = touchFile(this.fileCache, p, 'read', step);
          this.fileMemory = rememberFile(this.fileMemory, p, { readAt: step });
        }
      }
      // review D23: every path the step changed is invalidated whatever the action was — a `run` that renames or
      // regenerates a file in view must not leave the old bytes in the next prompt
      if (draft.changedFiles.length > 0) {
        this.filesInView.invalidate(draft.changedFiles);
        for (const p of draft.changedFiles) {
          if (isChangeAction(a.kind)) this.fileCache = touchFile(this.fileCache, p, 'edit', step);
          this.fileMemory = rememberFile(this.fileMemory, p, { editedAt: step });
        }
      }
    }
    const image = this.lastPostImage;
    this.lastPostImage = null;
    if (image !== null && image.step === step) {
      for (const id of fileMemoryFromPostImage(image)) {
        if (id.deleted) {
          this.fileCache = dropFile(this.fileCache, id.rel);
          this.fileMemory = forgetFile(this.fileMemory, id.rel);
          this.filesInView.invalidate([id.rel]);
          continue;
        }
        this.fileMemory = rememberFile(this.fileMemory, id.rel, { ...(id.sha12 !== null ? { sha12: id.sha12 } : {}), ...(id.bytes !== null ? { bytes: id.bytes } : {}), editedAt: step });
      }
    }
    this.fileMemory = boundMemory(this.fileMemory);
    const ev = evictFiles(this.fileCache, { maxEntries: FILE_CACHE_MAX_ENTRIES, maxBytes: this.contextPolicy.fileCacheBytes });
    if (ev.evicted.length > 0) {
      this.fileCache = ev.kept;
      this.filesInView.invalidate(ev.evicted.map((e) => e.rel));
    }
    // §8.6: compaction runs after the commit of the triggering step, before the next intent
    const trigger = compactionDue({ step, compactEvery: this.contextPolicy.compactEvery, pct: this.contextUsage.pct, mode: this.contextPolicy.compaction, foldable: foldableCount(this.history) });
    if (trigger !== null) this.compactContext(step, trigger);
  }

  /**
   * §8.6 `context.kept: 'jev'` (F26): the ONE bounded ordering request the last compaction owes, paid once, just
   * before the prompt that would render the order. `'code'` — the default — never reaches `rankKept`'s Jev branch
   * at all (`deps.kept` decides that inside `rankKept`, which also refuses under `jev-off`), so the default
   * compactor stays free and deterministic and this method is a single `if` on every step of every run.
   *
   * Jev routes, never gates: every route out of the branch (policy, `jev-off`, no asker, nothing askable, an
   * escape, a throw) returns `rankKeptCode`'s order untouched, so a Jev outage costs the ORDER of a prompt hint
   * and nothing else. The flag is cleared before the await, so a failure cannot re-arm the request.
   */
  private async rankKeptItems(step: number): Promise<void> {
    if (!this.keptRankPending) return;
    this.keptRankPending = false;
    const draft = this.draft;
    const r = await rankKept(
      { task: this.opts.task, plan: this.plan, candidates: this.kept },
      {
        kept: this.contextPolicy.kept,
        mode: this.mode,
        // the engine's one metered, recorded path; absent when there is no open draft to charge the request to,
        // which `rankKept` reports as `fellBackTo: 'no-asker'` and answers with the code order
        ...(draft === null ? {} : { ask: async (state: Json, questions: Record<string, Question>): Promise<AskResult> => (await this.askRecorded(draft, 'context', state, questions)).res }),
      },
    );
    this.kept = r.kept;
    if (r.by === 'jev') this.emit({ type: 'transcript', step, level: 'info', text: `kept: ${r.kept.length} item${r.kept.length === 1 ? '' : 's'} ordered by Jev (1 request)` });
  }

  /**
   * §8.6 `'code'`: fold the history into the rolling summary, persist it, announce `context:compacted`, recompute the meter.
   * `'llm'` (the second bullet of §8.6 — one generator call with the opencode template) is not built here; it degrades to
   * `'code'`, which §8.6 already names as its fallback, so the event always reports `by: 'code'` while `ContextUsage.compaction`
   * keeps reporting the configured mode.
   */
  private compactContext(step: number, trigger: CompactionTrigger): void {
    const at = nowIso();
    const allowance = Math.floor(this.contextPolicy.budgetChars * HISTORY_SHARE);
    const r = compactCode({ step, at, task: this.opts.task, plan: this.plan, history: this.history, fileMemory: this.fileMemory, lastTestRun: this.lastTestRun, previous: this.summary });
    // review D15: the event and the meter report PROMPT chars — what the fold removes from the message the generator
    // sees — not the size of the persisted JSON. Both sides are measured with the planner the prompt itself uses; before
    // the first build of a process (the §8.6 resume trigger) the two sections stand in for the whole prompt.
    const sectionsBefore = planHistory(this.history, allowance).chars + (this.summary?.text.length ?? 0);
    const historyAfter = planHistory(r.history, allowance).chars;
    const sectionsAfter = historyAfter + r.summary.text.length;
    const before = this.contextUsage.promptChars > 0 ? this.contextUsage.promptChars : sectionsBefore;
    const chars = { before, after: Math.max(0, before - Math.max(0, sectionsBefore - sectionsAfter)) };
    this.history = r.history;
    this.summary = r.summary;
    this.summaryAt = step;
    // §8.6 fourth bullet (F26): the extraction, which is the whole mechanism under `context.kept: 'code'` — pure,
    // free, deterministic, and run over the history BEFORE the fold collapsed it is not needed: every input here
    // (`plan`, `fileMemory`, `lastTestRun`, the folded history's own reasons) survives the fold. The human items
    // already on the list are carried forward unranked; nothing else about them is this module's business.
    this.kept = extractKept({
      task: this.opts.task,
      plan: this.plan,
      history: this.history,
      fileMemory: this.fileMemory,
      lastTestRun: this.lastTestRun,
      // §8.6's "failing test ids + assertion lines", read by the same code the oracle and the fast path use, so
      // the kept facts name the tests the way every other artefact of this run names them
      failingTests: this.lastTestRun === null ? [] : fastPathFailingIds(this.lastTestRun.command, this.lastTestRunOutput),
      testOutput: this.lastTestRunOutput,
      human: this.kept.filter((k) => k.by === 'human'),
      // §8.6 "do not re-derive" (review defect A4): the derived items this run already holds. Without them the
      // extraction is a pure function of the 12-step history window, so a fact left `kept` at exactly the moment
      // it left the prompt — `kept` then held nothing the prompt did not already carry, which is the one thing
      // §8.6 exists to do. `KEPT_MAX` still bounds the union and recency still cuts the oldest first.
      carried: this.kept.filter((k) => k.by !== 'human'),
    });
    // §8.6: one bounded ordering request per compaction, and only under `'jev'`. It is owed rather than made here
    // because `compactContext` is synchronous (it runs inside `commit`); `contextView` pays it before the next
    // prompt is built, which is the first moment the order can matter and the last moment it is free to wait.
    this.keptRankPending = this.contextPolicy.kept === 'jev' && this.kept.length > 0;
    this.compactions += 1;
    this.lastCompactionAt = at;
    if (hasContextStore(this.store)) this.persist(this.store.writeContextSummary(toJson(r.summary)), `${CHECKPOINT_FILES.context}/${CONTEXT_SUMMARY_FILE}`);
    const event: Extract<EngineEvent, { type: 'context:compacted' }> = { type: 'context:compacted', step, chars, by: 'code' };
    // contract 1.4: the union now carries the event, so `--json` and a subscribing renderer get it typed. It yields no
    // transcript item of its own (`itemsFromEvent` has no case for it), so the human-readable line stays the notice below.
    this.emit(event);
    // review finding 29: ONE shared line in all three sinks — the notice, kind `ui` with the `[ui]` label, which
    // `itemsFromEvent` turns into a single `notice` item (never a `[jevcode]` chat bubble); `detail` carries the event JSON.
    const why = trigger === 'interval' ? `every ${this.contextPolicy.compactEvery} steps` : trigger === 'budget' ? `prompt at ${this.contextUsage.pct}% of the context budget` : trigger === 'resume' ? 'resumed past the history window' : 'requested';
    const folded = `${r.dropped.length} step${r.dropped.length === 1 ? '' : 's'} folded into the summary`;
    this.emit({ type: 'notice', step, kind: 'ui', level: 'info', label: '[ui]', text: `compaction: ${chars.before} → ${chars.after} prompt chars (code); ${folded} at step ${step} (${why})`, detail: JSON.stringify(event) });
    // §12.0.3 cadence point 2: the meter after a compaction, in the same units
    this.lastRecentSteps = { ...this.lastRecentSteps, chars: historyAfter };
    this.contextUsage = this.usage(chars.after, { summaryAt: step, lastCompactionAt: at });
  }

  /** §8.5 / review D12: the per-run output bound deleted these steps' files — every pointer to them stops being printed. */
  private noteOutputsEvicted(steps: readonly number[]): void {
    const gone = new Set(steps);
    let hit = false;
    this.history = this.history.map((e) => {
      if (!gone.has(e.step) || e.outputRef === undefined || e.outputEvicted === true) return e;
      hit = true;
      return { ...e, outputEvicted: true };
    });
    for (const step of gone) {
      this.outputViews.delete(step);
      this.missingOutputs.add(step);
    }
    if (hit) this.emit({ type: 'transcript', step: this.step, level: 'info', text: `outputs/: the 64 MiB per-run bound dropped step ${[...gone].sort((a, b) => a - b).join(', ')} — their history lines no longer point at a file` });
  }

  /** The current step's window entry before judge (Jev's `recent` includes it, §5.5). */
  private provisionalEntry(draft: StepDraft): WindowEntry {
    return buildWindowEntry({
      step: draft.step,
      intent: draft.intent?.intent ?? null,
      action: draft.proposal ? summariseAction(draft.proposal.action) : '(no proposal)',
      outcome: draft.outcome,
      output: draft.output.length > 0 ? draft.output : null,
      judge: null,
      completion: null,
      shownFiles: this.shownFiles(draft),
      notes: [],
      error: null,
    });
  }

  private shownFiles(draft: StepDraft): string[] {
    const out = [...draft.contextFiles];
    if (draft.proposal?.action.kind === 'read' && draft.outcome && draft.outcome.status === 'executed') for (const p of draft.proposal.action.paths) if (!out.includes(p)) out.push(p);
    return out;
  }

  // -------------------------------------------------------------------------------------
  // Stage failure / interruption policy (§6, §9.1)
  // -------------------------------------------------------------------------------------

  private async handleStepError(e: unknown, stage: StageName, draft: StepDraft): Promise<{ discard: boolean; stop: StopReason | null }> {
    draft.lastError = e;
    this.lastErrorStage = stage;
    const aborted = this.signal.aborted || isAbortError(e) || isBudgetError(e);
    if (aborted) {
      const cls = this.classifyStop(this.signal.aborted ? this.signal.reason : e);
      if (this.fatalError !== null) cls.stop = 'error';
      if (!draft.executeStarted) {
        // Rule 1: the step is discarded; the proposal is kept for the transcript.
        this.interrupted = { step: draft.step, stage, proposal: draft.proposal };
        // contract 1.4 (§12.0.2 P2 / P3): the pause-now snapshot's detail beside it, and the point when this stop is the pause
        this.noteDiscardDetail(draft, stage, cls.stop);
        this.emit({ type: 'transcript', step: draft.step, level: 'info', text: `step ${draft.step} interrupted during ${stage} (${cls.interrupt}); discarded` });
        return { discard: true, stop: cls.stop };
      }
      if (!draft.executeFinished) {
        // Rule 2: committed as interrupted; partial exec is absent when the sandbox rejected.
        draft.outcome = { status: 'interrupted' };
        draft.changedFiles = await this.workspace.changedFiles().catch(() => [] as string[]);
        draft.interruptedAt = { stage: 'execute', reason: cls.interrupt };
        draft.observed = false;
        this.emit({ type: 'outcome', step: draft.step, outcome: draft.outcome });
        return { discard: false, stop: cls.stop };
      }
      // Rule 3: the real outcome is kept; no judge evidence.
      draft.judge = null;
      draft.completion = null;
      draft.interruptedAt = { stage: 'judge', reason: cls.interrupt };
      draft.notes.push('interrupted before judge');
      // contract 1.4 (§12.0.2 P5): a pause-now cut the judge — the executed action is kept, one Jev call saved
      if (cls.interrupt === 'human_pause') this.pauseLandedInExecute = true;
      return { discard: false, stop: cls.stop };
    }
    // TUI-DESIGN §13.3: a failure that asks for a blocking pause discards the step (rule 1) when no action ran; the loop top awaits the answer
    const staged = this.stageBlock;
    this.stageBlock = null;
    const block = staged?.request ?? this.classifyBlocking(e, draft.step);
    if (block !== null && !draft.executeStarted) {
      this.installBlock(block, staged?.error ?? e);
      this.interrupted = { step: draft.step, stage, proposal: draft.proposal };
      this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `step ${draft.step} interrupted during ${stage} (${block.kind}); discarded` });
      this.emitStatus();
      return { discard: true, stop: null };
    }
    const err = toJevCodeError(e);
    if (e instanceof GeneratorResponseError && stage === 'propose') {
      // Twice-malformed generator reply: generator behaviour, observed by the loop detector.
      this.flushGeneratorRecords(draft);
      this.lastStageError = e;
      draft.generatorFailReason = e.reason;
      draft.outcome = { status: 'failed', error: 'propose: generator_response' };
      draft.error = { stage: 'propose', code: 'generator_response', message: this.redact(e.message) };
      draft.errorClass = e.name;
      this.consecutiveStageFailures += 1;
      this.counters.failed += 1;
      this.emit({ type: 'error', step: draft.step, error: serializeError(e, this.redact), fatal: false });
      this.emit({ type: 'outcome', step: draft.step, outcome: draft.outcome });
      return { discard: false, stop: null };
    }
    const actionError = (isJevCodeError(e) && ACTION_ERROR_CODES.includes(e.code) && (stage === 'risk' || stage === 'execute')) || (stage === 'execute' && !isJevCodeError(e));
    if (actionError) {
      // Action-level errors (EditError, PatchError, path escapes, and plain fs errors such as ENOENT
      // on a `read` of a missing path) are outcomes, not stage failures (§6 stage table).
      draft.outcome = { status: 'failed', error: this.redact(err.message) };
      draft.errorClass = e instanceof Error ? e.name : err.name;
      draft.executeFinished = true;
      this.counters.failed += 1;
      this.emit({ type: 'outcome', step: draft.step, outcome: draft.outcome });
      return { discard: false, stop: null };
    }
    // Stage failure: nothing downstream runs, the step is committed with `error`. Jev/provider
    // failures are not generator behaviour, so nothing is observed unless an action already ran
    // (judge failure: the executed action is observed as in §9.1 rule 3).
    this.lastStageError = e;
    this.flushGeneratorRecords(draft);
    draft.error = { stage, code: err.code, message: this.redact(err.message) };
    draft.observed = stage === 'judge' && draft.executeFinished;
    this.consecutiveStageFailures += 1;
    // §A1: a later transient failure keeps the streak, so a long task survives a blip the adapter's own retries did not
    if (this.mode === 'agent' && stage === 'propose' && e instanceof ProviderHttpError && (!e.retryable || this.step === 0)) this.agentProviderStop = true;
    if (stage === 'propose' || stage === 'risk' || (stage === 'execute' && !draft.executeFinished)) {
      draft.outcome = { status: 'failed', error: `${stage}: ${err.code}` };
      draft.errorClass = err.name;
      this.counters.failed += 1;
      this.emit({ type: 'outcome', step: draft.step, outcome: draft.outcome });
    } else if (stage === 'judge') {
      draft.judge = null;
      draft.completion = null;
      draft.notes.push(`unjudged: ${err.code}`);
    }
    this.emit({ type: 'error', step: draft.step, error: serializeError(e, this.redact), fatal: false });
    return { discard: false, stop: null };
  }

  // -------------------------------------------------------------------------------------
  // Commit point (§6 commit, §11 state-mutation rule)
  // -------------------------------------------------------------------------------------

  private commit(draft: StepDraft): { stop: StopReason | null } {
    const step = draft.step;
    // contract 1.9 (Fastlane) §2.6 / §5.2 / §7.5 seam (c) — STEP COMMIT, and the first line of it. This is I4's
    // other half: the step's token is invalidated here, so no router answer still in flight may be applied to a
    // record that is about to be written, and the step's ledger is taken (and its key closed for good, so a late
    // `stepTokenFor` cannot resurrect the step — defect 6).
    //
    // Behind the switch, and that is not decoration (I2): `commitStepRouters` CLOSES the key whether or not a
    // router ran, and a closed key hands out a permanently-invalid token. A routers-off run that closed
    // `(runId, 1…n)` would therefore disarm every router of the next run in the same process that reused the run
    // id — which is exactly what a `jev-on` / `jev-on-next` A/B over one fixture does. Off, this seam is not
    // entered at all, and `StepRecord.router` / `StepTiming.routerWaitMs` stay absent.
    const routerLedger = routersOn(this.mode, this.opts.routers) ? commitStepRouters(this.runId, step) : null;
    const proposal = draft.proposal;
    const outcome = draft.outcome;
    const status = outcome?.status ?? null;
    const evidence: ClaimEvidence = (() => {
      if (proposal === null) return { kind: 'none', because: 'no proposal' };
      // jev-off, and the llm-jev generic fallback (docs/LLM-JEV-DESIGN.md §9.4: keyed on draft.proposer, not the mode): claims verbatim;
      // agent mode too (docs/AGENT-LOOP-DESIGN.md §15 S4 item 5: no judge is asked, the todo list is the model's own bookkeeping)
      if (this.mode === 'jev-off' || draft.proposer === 'generic' || this.mode === 'agent') return status === 'executed' || status === 'noop' ? { kind: 'verbatim' } : { kind: 'none', because: `outcome ${status ?? 'none'}` };
      if (draft.claimProbabilities !== null && draft.judge !== null) return { kind: 'judged', probabilities: draft.claimProbabilities };
      // llm-jev (docs/LLM-JEV-DESIGN.md §3 row 7): the code verdicts are the claim evidence even without a JudgeResult (a verified `done`); a step without them claims nothing
      if (this.mode === 'llm-jev' && draft.claimProbabilities !== null && !draft.interruptedAt) return { kind: 'judged', probabilities: draft.claimProbabilities };
      if (draft.interruptedAt) return { kind: 'none', because: 'interrupted' };
      if (draft.error) return { kind: 'none', because: `stage failure at ${draft.error.stage}` };
      return { kind: 'none', because: `outcome ${status ?? 'none'}` };
    })();
    const stale = draft.intent && draft.intent.planStillValid < PLAN_STALE_THRESHOLD ? { probability: draft.intent.planStillValid } : null;
    const update = applyPlanDraft({
      plan: this.plan,
      draft: proposal && !draft.interruptedAt ? proposal.plan : null,
      step,
      claims: draft.claims,
      claimsDropped: draft.claimsDropped,
      evidence,
      newInformation: draft.judge?.newInfo ?? null,
      replan: draft.directive ? { text: draft.directive.text } : null,
      stale,
      // TUI-DESIGN §8.3 / §8.6: step 1 of a seeded run and a steered step may drop obsolete `remaining` items without a replan problem
      human: (this.seeded && step === 1) || this.activeHuman?.step === step,
    });
    let plan = update.plan;
    const notes = [...draft.notes, ...update.notes];
    if (draft.replayed) notes.push('replayed the paused proposal (risk re-checked)');
    if (status === 'noop' && this.mode === 'llm-jev') {
      // docs/LLM-JEV-DESIGN.md §6.6: a `done` completes only on the engine's own passing, current run; `task_complete` is recorded, not consulted
      if (!this.completeAfter(draft)) notes.push(`done rejected: no passing, current run verifies it${draft.completion !== null ? ` (task_complete=${draft.completion.toFixed(2)} recorded only)` : ''}`);
    } else if (status === 'noop' && usesJev(this.mode) && draft.completion !== null && !isComplete(draft.completion, this.opts.limits.completeThreshold)) {
      notes.push(`done rejected: task_complete=${draft.completion.toFixed(2)}`);
    }
    if (draft.interruptedAt?.stage === 'execute') notes.push(draft.interruptedAt.reason === 'wall_time' ? 'stopped by wall-time budget' : `interrupted (${draft.interruptedAt.reason})`);
    if (draft.judge && draft.claims.length > 0) draft.judge.doneClaims = update.doneClaims;

    const entry = buildWindowEntry({
      step,
      intent: draft.intent?.intent ?? null,
      action: proposal ? summariseAction(proposal.action) : '(no proposal)',
      outcome,
      output: draft.output.length > 0 ? draft.output : null,
      judge: draft.judge,
      completion: draft.completion,
      shownFiles: this.shownFiles(draft),
      notes,
      error: draft.error ? `${draft.error.stage}: ${draft.error.message}` : null,
    });
    const window = pushWindow(this.window, entry);

    // Code-computed workspace facts (§5.5), persisted for --resume.
    if (status === 'executed' && draft.changedFiles.length > 0 && proposal && proposal.action.kind !== 'run' && proposal.action.kind !== 'read') this.lastChangeStep = step;
    // docs/AGENT-LOOP-DESIGN.md §2.2: in agent mode a command other than the test command that changed a file (its per-step set)
    if (this.mode === 'agent' && draft.agentChanged) this.lastChangeStep = step;
    if (draft.tests?.parsed) {
      // docs/AGENT-LOOP-DESIGN.md §3.3: an agent test run in a subdirectory is recorded as `cd <dir> && <command>` — where it ran
      const testCommand = this.mode === 'agent' && proposal?.action.kind === 'run' ? recordedTestCommand(draft.tests.command, proposal.action.cwd) : draft.tests.command;
      // contract 1.9 (Fastlane) §4.3 T5: `durationMs` is the member that lets the fast-path predicate survive a resume
      this.lastTestRun = { step, command: testCommand, passed: draft.tests.parsed.passed, failed: draft.tests.parsed.failed, errors: draft.tests.parsed.errors, allPassed: draft.tests.allPassed === true, durationMs: Math.round(Math.max(0, draft.timing.execMs)) };
      // the run's output tail for the `done` state's `lastRun.output` (loop/synth team request; state.ts ExecutedInfo.lastRunOutput)
      this.lastTestRunOutput = draft.output;
      // contract 1.9 (Fastlane) §4.3 T3 / §6 row 14: the scope-usability verdict on the loop's OWN run
      this.lastTestRunScopeUsable = scopeUsable(draft.tests.parsed);
    }
    for (const p of draft.created) this.createdThisRun.add(p);
    if (status === 'executed' && proposal?.action.kind === 'read') this.counters.reads += 1;

    // Timing and usage.
    const total = Math.max(0, this.clock() - draft.t0);
    const timing: StepTiming =
      this.mode === 'llm-jev'
        ? this.llmJevTiming(draft, total)
        : {
            generatorMs: draft.timing.generatorMs,
            jevMs: draft.timing.jevMs,
            execMs: draft.timing.execMs,
            harnessMs: Math.max(0, total - draft.timing.generatorMs - jevChargedMs(draft) - draft.timing.execMs - draft.timing.confirmMs - draft.timing.coordWaitMs),
            totalMs: total,
            // the ONE optional-bucket builder, shared with `llmJevTiming`
            ...optionalStepTiming(optionalTimingInput(draft)),
          };
    // F13 (finishing pass): ONE fold over `RUN_TIMING_BUCKETS`, so `RunResult.timing` is by construction the sum
    // of the committed `steps.jsonl` rows PLUS the wall of any discarded attempt (§9.1 rule 1, see
    // `absorbDiscardedTiming` and the `addStepTimingToRun` header — review defect A9: the original wording here
    // claimed the rows alone, which is false on any run with a blocking pause). Four buckets (`coordinateMs`,
    // `coordWaitMs`, `fastPathMs`, `fastPathJevMs`) were written per step and named in no run-level sum; an
    // inline list is exactly how they were missed.
    addStepTimingToRun(this.timing, timing);
    // TUI-DESIGN §9.2: the per-step cost series behind `stepsLeftEstimate`
    this.costPerStep.push(draft.usage.generator.costUsd + draft.usage.jev.costUsd);
    const generatorTokens = draft.usage.generator.inputTokens + draft.usage.generator.outputTokens;
    const jevTokens = draft.usage.jev.inputTokens + draft.usage.jev.outputTokens;
    this.generatorTokensPerStep.push(generatorTokens);
    this.jevTokensPerStep.push(jevTokens);
    this.tokensPerStep.push(generatorTokens + jevTokens);

    // Loop detector: replan issued this step resets first, then this step is observed.
    if (draft.directive) {
      this.detector.onReplan(step, draft.directive.text);
      this.directive = draft.directive;
      this.counters.replans += 1;
    }
    // docs/AGENT-LOOP-DESIGN.md §2.2 / §3.6: agent mode runs its own detector in the driver; the legacy one neither signs nor observes
    const signatures: string[] = this.mode === 'agent' ? [] : computeSignatures({
      proposal,
      outcome,
      output: draft.output.length > 0 ? draft.output : null,
      // A fallback that lands on Jev's own argmax answer is not an unresolved intent (Fix 3): only a
      // fallback away from the answer (escape, or an answer whose paired Noul was too low) is signed.
      intentFallback: draft.intent !== null && draft.intent.verdict === 'fallback' && draft.intent.answer !== draft.intent.intent,
      generatorFailReason: draft.generatorFailReason,
      errorClass: draft.errorClass,
      observed: draft.observed,
      workspaceRoot: this.workspace.root,
      // the workspace test command's runner, so the fail: signature uses its parser (loop/synth team request; loopdetect.ts SignatureInput.testRunner)
      testRunner: draft.tests ? (this.wsInfo.testCommand?.runner ?? null) : null,
    });
    const trip = this.mode === 'agent' ? null : this.detector.observe(step, signatures);
    if (trip) {
      this.counters.loops += 1;
      this.emit({ type: 'loop:tripped', step, signature: trip.signature, occurrences: trip.occurrences });
      if (this.mode === 'jev-off') {
        // §13: fixed text instead of the replan Choice; stored like a directive.
        const text = loopTripText(trip.signature);
        plan = { ...plan, harnessProblems: [...plan.harnessProblems.filter((h) => h.kind !== 'replan'), { kind: 'replan', text, step }] };
        this.detector.onReplan(step, text);
        this.pendingLoopNotice = text;
      }
    }
    if (signatures.includes(INTENT_UNRESOLVED_SIGNATURE)) notes.push('intent unresolved: fallback to investigate');
    // docs/AGENT-LOOP-DESIGN.md §3.6 / §8: a trip the driver's detector reported — a nudge (the driver words it), counted; the trip
    // after AGENT_MAX_LOOP_NUDGES stops the run `stuck` once this step is committed (exit 4, resumable)
    let agentStop: StopReason | null = null;
    const agentTrip = draft.agent?.loopTrip;
    if (agentTrip !== undefined) {
      this.counters.loops += 1;
      this.emit({ type: 'loop:tripped', step, signature: agentTrip.signature, occurrences: agentTrip.count });
      const nudges = this.counters.loopNudges ?? 0;
      if (nudges >= AGENT_MAX_LOOP_NUDGES) {
        agentStop = 'stuck';
        this.emit({ type: 'transcript', step, level: 'warn', text: `stuck: the agent repeated itself after ${nudges} loop nudges (${agentTrip.tool}, rule ${agentTrip.rule}, ${agentTrip.count}×); resume to continue` });
      } else this.counters.loopNudges = nudges + 1;
    }

    // Hints for the next prompt.
    if (draft.matchesIntent !== null && draft.matchesIntent < MATCHES_INTENT_THRESHOLD && draft.intent) this.nextHints.intentMismatch = { intent: draft.intent.intent, probability: draft.matchesIntent, step };
    if (draft.claimsDropped > 0) this.nextHints.claimsDropped = draft.claimsDropped;

    // §6: only a step WITHOUT a stage failure resets the counter; three consecutive steps with one stop the run with 'error'.
    if (draft.error === null) this.consecutiveStageFailures = 0;
    this.jevQuestions += draft.decisions.length;

    this.step = step;
    this.plan = plan;
    this.window = window;
    // docs/COORDINATION-DESIGN.md §8: the generator's history, files in view and (when due) the compaction — before the snapshot below
    this.commitContext(draft, entry, step);
    this.interrupted = null;
    this.interruptedDetail = null;
    if (this.replayCache !== null && this.replayCache.step === step) this.replayCache = null;
    // TUI-DESIGN §8.6: the directives reached exactly this step; the next steer re-arms them
    if (this.activeHuman?.step === step) this.activeHuman = null;
    this.emit({ type: 'plan', step, plan, rejectedDone: update.rejected.map((r) => r.text), unverifiedDone: update.unverified.map((u) => u.text) });

    const record: StepRecord = {
      step,
      startedAt: draft.startedAt,
      intent: draft.intent?.intent ?? null,
      intentAnswer: draft.intent?.answer ?? null,
      contextFiles: draft.contextFiles,
      proposal,
      risk: draft.risk,
      outcome,
      judge: draft.judge,
      completion: draft.completion,
      decisions: draft.decisions,
      jevRequests: draft.jevRequests,
      ...(() => { const hits = draft.jevRequests.filter((r) => r.cached === true).length; return hits > 0 ? { jevCacheHits: hits } : {}; })(),
      usage: draft.usage,
      timing,
      loopSignatures: signatures,
    };
    // contract 1.5 (ORCHESTRATION-DESIGN §2.4 [G8] / §2.6 [G1]): both absent on every run without `orchestration`
    if (this.escapedThisStep.length > 0) record.escaped = [...this.escapedThisStep];
    if (this.commitThisStep !== null) record.commit = this.commitThisStep;
    this.escapedThisStep = [];
    this.commitThisStep = null;
    if (draft.proposer !== null) record.proposer = draft.proposer;
    // docs/AGENT-LOOP-DESIGN.md §2.3 / §10: absent in every other mode
    if (draft.agent !== null) record.agent = draft.agent;
    if (this.mode === 'agent') this.agentSteps.push(draft.agent !== null ? { agent: draft.agent } : {});
    // contract 1.9 (Fastlane) §2 / §5.2 / §7.5 seam (c): the step's router rows, and the three members that had no
    // writer until this seam. `routerWaitMs` is I3 IN THE RECORD — the sum of the per-route measured waits, which
    // is 0 on every step that is not a bug (the ask's own latency stays in `jevMs`). All four absent with the
    // routers off: `commitStepRouters` returned null and the risk stage returned neither member.
    if (routerLedger !== null) {
      record.router = { issued: routerLedger.issued, applied: routerLedger.applied, dropped: routerLedger.dropped, waitMs: routerLedger.waitMs, rows: routerLedger.rows };
      timing.routerWaitMs = routerLedger.waitMs;
    }
    if (draft.riskSource !== null) record.riskSource = draft.riskSource;
    // §5.2: "Absent = false" — only the outage is a row, and `riskSource: 'jev'` already says the other case
    if (draft.jevUnavailable === true) record.jevUnavailable = true;
    // contract 1.9 (Fastlane) §5.2: both absent unless the fast path armed this step, which is I2
    if (draft.fastPath !== null) {
      record.fastPath = draft.fastPath;
      // §6 row 14: the verdict the TRIGGER read, not the verdict this step's own run left behind
      record.scopeUsable = draft.scopeUsable ?? this.lastTestRunScopeUsable;
    }
    // docs/LLM-JEV-DESIGN.md §9.3: the synthesizer's step carries its verification counts. F04 (finishing pass) widens
    // the writer from "llm-jev and the synthesizer proposed" to "OR something was reported on this step": a jev-only
    // synthesizer's warm counters, and (contract 1.9 §3.1–§3.4) the S2 facts the jev-on propose path records about its
    // own call, both have a reporter and neither is `llm-jev` + `proposer: 'synth'`. The llm-jev shape is unchanged —
    // that arm always reports or has tallies to write — so contract 1.9 optionality and the llm-jev goldens hold, and a
    // step nobody reported on still writes no `verify` member at all.
    if (draft.verify.reported !== null || s2Measured(draft) || (this.mode === 'llm-jev' && draft.proposer === 'synth')) record.verify = this.verifySummary(draft, proposal);
    // contract 1.4 (W2b) (§4.1): a conditional spread everywhere else, a conditional assignment here — a step
    // whose gate saw nothing writes the row it wrote before this wave, which is half of what M2 means by zero cost
    if (draft.coord !== null) record.coord = draft.coord;
    if (draft.interruptedAt) record.interruptedAt = draft.interruptedAt;
    if (draft.error) record.error = draft.error;
    if (this.completeAfter(draft)) record.stoppedAt = 'complete';
    else if (checkBudgets(this.budgetInput()) !== null) record.stoppedAt = 'step_start';
    // TUI-DESIGN §8.7 / §15 item 3: the committed plan after this step, bounded, so /rewind N seeds without replaying drafts
    record.planAfter = planSnapshot(plan);

    const endSerialise = stepTimeline.span('serialise', 'checkpoint-state');
    const snapshot = this.buildCheckpointState();
    endSerialise();
    const c0 = this.clock();
    this.pendingCheckpoint = (async () => {
      // TUI-DESIGN §12.3: nothing is hashed in here, where the lag gate could not see it
      let file: string = CHECKPOINT_FILES.steps;
      try {
        await this.store.appendStep(record);
        file = CHECKPOINT_FILES.state;
        await this.store.writeState(snapshot);
        this.emit({ type: 'checkpoint', step, ms: Math.max(0, this.clock() - c0) });
      } catch (e) {
        this.emit({ type: 'error', step, error: serializeError(e, this.redact), fatal: false });
        // TUI-DESIGN §13.3: a disk-class failure of state.json pauses at the next boundary (`checkpoint degraded: <code> on state.json`)
        this.noteDiskError(e, file, step);
      }
    })();
    // contract 1.4 (W2b), §4.3 step 7 + §3.3 point 2: the lease is released with the post-image set and ONE beat
    // goes out with what was touched — both hung off `pendingCheckpoint.then`, OUTSIDE the IIFE's try/catch, because
    // that catch classifies any errno as `checkpoint degraded: <code> on state.json` and a ledger fault is not that.
    // The IIFE catches internally, so the `.then` always runs. Neither is ever awaited by the loop.
    if (this.coord !== null) {
      const coord = this.coord;
      const image = this.lastPostImage;
      const changed: Record<string, string | null> = {};
      const files: string[] = [];
      for (const [rel, f] of Object.entries(image?.files ?? {})) {
        if (files.length >= LEASE_CHANGED_MAX) break;
        files.push(rel);
        changed[rel] = f.sha256 ?? null;
      }
      // §3.3: `touchedRecent` is the union of the last THREE committed steps, so a peer arriving mid-run sees more
      // than the one step that happened to be committing when it folded.
      this.touchedRecent = [...new Set([...files, ...this.touchedRecent])].slice(0, TOUCHED_RECENT_KEEP);
      const head = image?.headOid ?? null;
      void this.pendingCheckpoint.then(() => {
        coord.released('committed', changed, head ?? undefined);
        coord.beat({ ...this.heartbeatDynamic(), touched: { step, files } });
      });
    }
    // TUI-DESIGN-2 §6 item 3: money for the `[step N]` summary line (absent → the renderer falls back to tokens)
    this.emit({ type: 'step:end', record, costUsd: { generator: record.usage.generator.costUsd, jev: record.usage.jev.costUsd } });
    this.emitStatus();
    // §4.8: rows of samples that ended after the propose stage's flush (a round draining through execute / judge) go out with
    // the step; from here on a late sample of this step writes its own row (pushGeneratorRecord)
    this.flushGeneratorRecords(draft);
    draft.closed = true;
    this.draft = null;
    this.currentStage = 'idle';
    stepTimeline.stage('');
    stepTimeline.endStep();
    return { stop: agentStop };
  }

  // -------------------------------------------------------------------------------------
  // Single exit path (§6 stop, §11 shutdown)
  // -------------------------------------------------------------------------------------

  private async finish(reason: StopReason, opts: { detail?: string; skipWrite?: boolean } = {}): Promise<RunResult> {
    trace(`finish(${reason}) pendingCheckpoint=${this.pendingCheckpoint !== null} persists=${this.pendingPersists.size}`);
    if (this.lastResult) return this.lastResult;
    // TUI-DESIGN §8.6: from here on steer/unsteer/pause/annotate read as finished — the snapshot below is what gets written
    this.finishing = true;
    this.deadline?.clear();
    this.currentStage = 'idle';
    this.stopReason = reason;
    let error: SerializedError | null = null;
    if (reason === 'error') {
      if (this.fatalSerialized !== null) {
        // contract 1.1 (TUI-DESIGN §13.4): abort('error', { error }) named the fatal error
        error = this.fatalSerialized;
      } else {
        const src = this.fatalError ?? this.lastStageError;
        if (src !== null) error = serializeError(src, this.redact);
        if (isJevCodeError(src) && !this.stateError) this.stateError = { stage: this.lastErrorStage ?? 'intent', code: src.code };
      }
    }
    // TUI-DESIGN §9.2 / §9.5: the budget:stop item precedes the stop and run:end lines (not for a refused resume, whose transcript is muted)
    if (!opts.skipWrite) this.emitBudgetStop(reason, opts.detail);
    // contract 1.4 (COORDINATION-DESIGN §12.0.2): the pause-now cache settles and the PausePoint is built before the final snapshot;
    // §7.5: one bound for the whole shutdown — what the cache wait spends is taken off the final write's share below
    const shutdownDeadline = this.clock() + SHUTDOWN_CHECKPOINT_BOUND_MS;
    if (!opts.skipWrite) await this.settlePausePoint(reason, shutdownDeadline);
    // contract 1.5 (ORCHESTRATION-DESIGN §2.6, corner rows 36/37 inverted): the child's unconditional end commit, once,
    // when the add set is non-empty. After it, an `addSet ≠ ∅` in that worktree means the process DIED — it is the
    // crash case, not the default. A run with no `orchestration.runGit` seam makes no git mutation here or anywhere.
    if (!opts.skipWrite) await this.commitAtEnd();
    const snapshot = this.buildCheckpointState();
    // TUI-DESIGN-2 §2.4: the cost basis of this process's Jev requests rides the result for `costBlock`'s suffix
    const result: RunResult = { ...assembleRunResult({ runId: this.runId, mode: this.mode, reason, state: snapshot, error }), jevCostBasis: this.jevCostBasis(), ...(this.endCommit !== null ? { commit: this.endCommit } : {}) };
    const stopLine: EngineEvent = { type: 'transcript', step: null, level: reason === 'complete' ? 'info' : 'warn', text: stopTranscriptLine(reason, this.step, opts.detail) };
    let stateWritten = opts.skipWrite === true; // a refused resume leaves the stored state.json as it was
    // TUI-DESIGN §13.5 / §15 item 14: exit code, resumability and the artefact paths ride run:end; built when the final write has settled.
    // Pre-redacted so the line written before flush is the very event the renderers receive last.
    const buildEnd = (): EngineEvent => {
      // docs/AGENT-LOOP-DESIGN.md §A1: `answered` finishes a run like `complete` and `generator_done` (the one list, stop.ts)
      const resumable = stateWritten && !this.checkpointDegraded && !isFinishedStop(reason);
      const paths = { runDir: this.runDir, transcript: join(this.runDir, CHECKPOINT_FILES.transcript), log: join(this.runDir, CHECKPOINT_FILES.log) };
      return redactDeep({ type: 'run:end', result, exitCode: this.exitCodeOf(reason, error), resumable, paths } satisfies EngineEvent, this.redact) as EngineEvent;
    };
    let endEvent: EngineEvent | null = null;
    let stopEmitted = false;
    if (!opts.skipWrite) {
      const phase = (async (): Promise<void> => {
        // Stray background process groups from a successful run must not outlive it (§8); abort() already killed on its path.
        if (!this.aborting) await this.sandbox.killAll().catch(() => undefined);
        // contract 1.9 (Fastlane) §4.6: the fast path's own synthesizer and its search memory go with the run. Nothing
        // else in `jev-on` holds a search memory, so this drops exactly what this engine created and nothing shared.
        this.fastPathRunner?.dispose(this.runId);
        if (this.pendingCheckpoint) await this.pendingCheckpoint;
        trace('finish: checkpoint awaited, writing final state');
        try {
          await this.store.writeState(snapshot);
        } catch (e) {
          // TUI-DESIGN §13.3 / §13.5: a disk-class failure of the final state.json makes the run not resumable (exit 3)
          if (this.noteDiskError(e, CHECKPOINT_FILES.state, null)) this.checkpointDegraded = true;
          throw e;
        }
        stateWritten = true;
        trace('finish: final state written');
        // contract 1.4 (§7.4): `end` marks run.json with the final state, so a shell `--resume` needs --force too (§11 row 44)
        if (reason === 'human_pause' && this.endRequested !== null) {
          try {
            await this.store.updateMeta({ ended: { at: nowIso(), by: this.endRequested.by } });
          } catch (e) {
            this.emit({ type: 'transcript', step: null, level: 'warn', text: `${CHECKPOINT_FILES.meta} write failed (ended): ${e instanceof Error ? this.redact(e.message) : String(e)}` });
          }
        }
        // contract 1.4 (§12.0.2 "when emitted"): after the final state settled — `resumableAt` names a file that exists and
        // `replayable` is a fact — and before the stop line and run:end; never for another stop reason or a failed write
        if (reason === 'human_pause' && this.pausePoint !== null) {
          this.emitStatus();
          this.emit({ type: 'pause:point', point: { ...this.pausePoint } });
        }
        // The stop line and the run:end line reach transcript.log through the same item model as every other line (§10).
        // contract 1.7 (§3.6 D-V): `stopTranscriptLine` now returns '' — the row is deleted — so the event is not
        // emitted at all. Guarding HERE rather than only in `itemsFromEvent` keeps `--json` and every listener free
        // of an empty-text transcript event, not just the two rendered sinks.
        // contract 1.4 (W2b), §3.3 point 5: `phase:'ended'` AFTER the final `writeState`, before the stop line and
        // `run:end`, carrying the `PausePoint` — so a resume card on another device has the point without the run
        // dir (§12.0.2 "the same object rides the final phase:'ended' heartbeat"). Tracked leases are released
        // `ended` by the writer itself and the chain is awaited, inside the shutdown bound.
        if (this.coord !== null) {
          await this.coord
            .finish({
              ...this.heartbeatDynamic(),
              phase: 'ended',
              stopReason: reason,
              ...(this.pausePoint !== null ? { pausePoint: { ...this.pausePoint } } : {}),
            })
            .catch(() => undefined);
        }
        stopEmitted = true;
        if (stopLine.type === 'transcript' && stopLine.text.length > 0) this.emit(stopLine);
        endEvent = buildEnd();
        this.recordTranscript(endEvent);
        await Promise.allSettled([...this.pendingPersists]);
        await this.store.flush();
        // HARNESS-NEXT-DESIGN §4.4: the run's timing buckets, written once at the end (never per step)
        stepTimeline.endStep();
        await writeTimelineFile(this.runDir);
      })();
      let timer: NodeJS.Timeout | null = null;
      const bound = new Promise<'timeout'>((resolve) => {
        // contract 1.4 (§7.5): the remainder of the one shutdown bound (the pause cache above spent its share, if any)
        timer = setTimeout(() => resolve('timeout'), Math.max(0, shutdownDeadline - this.clock()));
        timer.unref();
      });
      const outcome = await Promise.race([phase.then(() => 'ok' as const, () => 'failed' as const), bound]);
      trace(`finish: phase outcome ${outcome}`);
      if (timer) clearTimeout(timer);
      // Renderer-only notices: the run:end line is already recorded, and a failing store cannot take another line anyway.
      if (outcome === 'timeout') {
        this.events.emit({ type: 'transcript', step: null, level: 'error', text: `final checkpoint exceeded ${SHUTDOWN_CHECKPOINT_BOUND_MS} ms; writing state synchronously and exiting` });
        try {
          // TUI-DESIGN §13.4: the injected exit restores the terminal and prints the epilogue before the process ends
          this.forceExit(this.exitCodeOf(reason, error));
        } catch {
          // an injected exit that throws (tests) must not re-enter the stop path
        }
      } else if (outcome === 'failed') {
        this.events.emit({ type: 'transcript', step: null, level: 'error', text: 'final checkpoint write failed' });
      }
    }
    // TUI-DESIGN §8.5: the lock ends with the run
    this.releaseLock();
    // §7.2 item 1: and so does the degrade listener — the last write above has settled, and `noteDisk` on a finished
    // engine would emit a notice no renderer is listening for.
    attachDegradeListener(this.store, null);
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.lastResult = result;
    if (!stopEmitted && stopLine.type === 'transcript' && stopLine.text.length > 0) this.emit(stopLine);
    this.emitStatus();
    // Already recorded in the checkpoint phase (or muted); emitted raw so it is not written twice.
    this.events.emit(endEvent ?? buildEnd());
    return result;
  }

  /** TUI-DESIGN §13.5: the one exit-code call — the fatal error, the degraded flag and the signal name refine it. */
  private exitCodeOf(reason: StopReason, error: SerializedError | null): number {
    return exitCodeFor(reason, error ?? this.fatalSerialized ?? undefined, this.checkpointDegraded, this.signalName ?? undefined);
  }

  /**
   * TUI-DESIGN §9.2 / §9.5: `budget:stop` before `run:end` for spend_cap (by the run or the session cap) and token_cap, with the
   * raise the epilogue and `/budget` name (`suggestedSpendCapUsd`: the whole dollar above the cap, above the spend).
   */
  private emitBudgetStop(reason: StopReason, detail: string | undefined): void {
    if (reason !== 'spend_cap' && reason !== 'token_cap') return;
    const at: StoppedAt = detail === 'before_execute' ? 'before_execute' : 'step_start';
    const step = this.step;
    if (reason === 'token_cap') {
      const cap = this.opts.limits.maxGeneratorTokens ?? this.generatorTokens;
      const minimum = Math.ceil((this.generatorTokens + 1) / TOKEN_CAP_RAISE_STEP) * TOKEN_CAP_RAISE_STEP;
      this.emit({ type: 'budget:stop', scope: 'run', by: 'tokens', spentUsd: this.generatorTokens, capUsd: cap, step, at, raise: { command: `/budget max-generator-tokens ${minimum}`, flag: '--max-generator-tokens', minimum } });
      return;
    }
    const snap = this.opts.meter.snapshot();
    const parent = snap.parent;
    if (parent && snap.parentExceeded === true && snap.totalUsd < snap.capUsd) {
      const minimum = suggestedSpendCapUsd(parent.capUsd, parent.totalUsd);
      this.emit({ type: 'budget:stop', scope: 'session', by: 'session', spentUsd: parent.totalUsd, capUsd: parent.capUsd, step, at, raise: { command: `/budget session-spend-cap ${minimum.toFixed(2)}`, flag: '--session-spend-cap', minimum } });
      return;
    }
    const minimum = suggestedSpendCapUsd(snap.capUsd, snap.totalUsd);
    this.emit({ type: 'budget:stop', scope: 'run', by: 'run', spentUsd: snap.totalUsd, capUsd: snap.capUsd, step, at, raise: { command: `/budget spend-cap ${minimum.toFixed(2)}`, flag: '--spend-cap', minimum } });
  }
}

// ---------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------

async function createRunDir(runsDir: string, newRunId: (now: Date) => string): Promise<string> {
  await mkdir(runsDir, { recursive: true });
  for (let attempt = 0; attempt < RUN_DIR_ATTEMPTS; attempt++) {
    const runId = newRunId(new Date());
    try {
      await mkdir(join(runsDir, runId));
      return runId;
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EEXIST')) throw e;
    }
  }
  throw new CheckpointError('could not allocate a unique run directory', runsDir);
}

async function validateResumeId(runsDir: string, runId: string): Promise<void> {
  if (!RUN_ID_RE.test(runId)) throw new ConfigError(`--resume: "${runId}" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxxxx)`, { setting: 'resume' });
  let base: string;
  try {
    base = await realpath(runsDir);
  } catch (e) {
    throw new CheckpointError(`runs directory ${runsDir} is not accessible`, runsDir, { cause: e });
  }
  let dir: string;
  try {
    dir = await realpath(join(runsDir, runId));
  } catch (e) {
    throw new CheckpointError(`run ${runId} not found under ${runsDir}`, join(runsDir, runId), { cause: e });
  }
  if (!dir.startsWith(base + sep)) throw new ConfigError(`--resume: run directory escapes ${runsDir}`, { setting: 'resume' });
}

/**
 * Create the engine: allocate (or load) the run, create the sandbox and workspace, take the
 * changed-files snapshot. Rejects with ConfigError/CheckpointError on a bad resume; run()
 * itself never rejects.
 */
/** Opt-in trace for shutdown debugging: JEVCODE_TRACE=<file> appends one line per checkpoint. */
function trace(msg: string): void {
  const f = process.env['JEVCODE_TRACE'];
  if (!f) return;
  try {
    appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // tracing must never affect the run
  }
}

/** §2.5(c) / §4.2 P10: the parked review's artefact, under `<runDir>/orchestrate/` (`CheckpointStore.cacheTarget` routes it). */
export function reviewCacheRel(step: number): string {
  return `${CHECKPOINT_FILES.orchestrate}/review-${step}.json`;
}

/** `seatbelt` is stronger than `none`; `auto` resolves to at least what the platform gives, never to less than `seatbelt` asked for. */
function sandboxWeakerThan(profile: SandboxProfile, parent: SandboxLevel): boolean {
  return parent === 'seatbelt' && profile === 'none';
}

/**
 * contract 1.5 (ORCHESTRATION-DESIGN §2.1, §2.6, corner row 20): the three refusals `createEngine` owes a child.
 *
 * 1. `depth > ORCHESTRATION_DEPTH_MAX` (1) — depth is a constant, not a setting, so an agent can never spawn agents.
 * 2. a depth-1 run that ALSO carries a split flag — `--agent` with `--split` is a `ConfigError`, so the gate cannot be
 *    forced open from the command line inside a child.
 * 3. a child whose resolved sandbox level is WEAKER than the parent's recorded one — `--sandbox` is one of the four
 *    rights §2.6's spawn line deliberately does not forward.
 *
 * A run without `EngineOptions.orchestration` (every run today) returns immediately.
 */
export function refuseOrchestration(opts: Pick<EngineOptions, 'orchestration' | 'sandboxProfile' | 'configRecord'>): void {
  const o = opts.orchestration;
  if (o === undefined) return;
  if (o.depth > ORCHESTRATION_DEPTH_MAX) {
    throw new ConfigError(`orchestration depth ${o.depth} exceeds the cap of ${ORCHESTRATION_DEPTH_MAX}: an agent cannot spawn agents`, { setting: 'orchestration.depth' });
  }
  if (o.depth === 1) {
    const split = opts.configRecord['orchestrate.split'];
    const value = split === undefined ? undefined : typeof split.value === 'string' ? split.value : undefined;
    if (value !== undefined && value !== 'off') {
      throw new ConfigError(`--agent ${o.slug ?? ''} with --split ${value}: an agent cannot delegate (the cap is ${ORCHESTRATION_DEPTH_MAX})`.replace('  ', ' '), { setting: 'orchestrate.split' });
    }
    if (o.parentSandbox !== undefined && sandboxWeakerThan(opts.sandboxProfile, o.parentSandbox)) {
      throw new ConfigError(`an agent may not run with a weaker sandbox than its parent (parent ${o.parentSandbox}, this run ${opts.sandboxProfile})`, { setting: 'sandbox' });
    }
  }
}

export async function createEngine(opts: EngineOptions, deps: EngineDeps = {}): Promise<Engine> {
  // jev-only and llm-jev (docs/LLM-JEV-DESIGN.md §3) put the Synthesizer in the propose stage
  if ((opts.mode === 'jev-only' || opts.mode === 'llm-jev') && !opts.synthesizer) throw new ConfigError(`${opts.mode} mode requires a synthesizer (EngineOptions.synthesizer)`, { setting: 'mode' });
  // contract 1.5 (ORCHESTRATION-DESIGN §2.1 / §2.6, corner row 20): the depth cap is refused HERE, not only in the TUI,
  // so a hand-typed `jevcode run --parent …` cannot make grandchildren, and a child can never be given weaker rights
  // than the parent recorded for itself.
  refuseOrchestration(opts);
  const d = await resolveDeps(deps);
  const redact = opts.redact;
  let root: string;
  try {
    root = await realpath(opts.workspace);
  } catch (e) {
    throw new ConfigError(`workspace ${opts.workspace} does not exist`, { setting: 'workspace', cause: e });
  }
  let runId: string;
  let store: CheckpointStore;
  let resume: ResumeLoad | null = null;
  let lock: { held: boolean; warning: string | null } | null = null;
  let reopened = false;
  if (opts.resume) {
    runId = opts.resume.runId;
    await validateResumeId(opts.runsDir, runId);
    store = d.createCheckpointStore(opts.runsDir, runId, redact);
    resume = await d.loadForResume(opts.runsDir, runId, redact, store);
    if (resume.store) store = resume.store;
    if (resume.state.runId !== runId) throw new CheckpointError(`state.json belongs to run ${resume.state.runId}, not ${runId}`, store.dir);
    if (resume.state.mode !== opts.mode) throw new ConfigError(`--resume: run ${runId} was a ${resume.state.mode} run`, { setting: 'mode' });
    if ((resume.previousStopReason ?? resume.state.stopReason) === 'complete' && !opts.resume.force) throw new ConfigError(`--resume: run ${runId} is complete; pass --force to continue it`, { setting: 'resume' });
    // contract 1.4 (COORDINATION-DESIGN §7.4, §11 row 44): an ended run needs --force to reopen — the gate is in the engine, not only the TUI picker
    const ended = resume.meta.ended ?? null;
    if (ended !== null && !opts.resume.force) throw new ConfigError(`--resume: run ${runId} was ended by ${ended.by} at ${ended.at}; pass --force to reopen`, { setting: 'resume' });
    reopened = ended !== null;
    // TUI-DESIGN §8.5: a live lock (same host, pid alive) refuses the resume with exit 2 before any further work
    lock = takeRunLock(store.dir || join(opts.runsDir, runId), runId);
  } else {
    runId = await createRunDir(opts.runsDir, d.newRunId);
    store = d.createCheckpointStore(opts.runsDir, runId, redact);
  }
  const runDir = store.dir || join(opts.runsDir, runId);
  // TUI-DESIGN §12.1 (D7): the two unsandboxed spawns before the sandbox exists; a probe that rejects reads as `git-missing`
  // and is not handed to createWorkspace, which then probes for itself
  let git: GitState | null;
  // AGENT-LOOP-DESIGN §A1 latency: an agent run starts from the caller's cached probe (no spawn before the first request) and
  // re-probes beside the first model turn; the engine adopts the fresh probe before any tool call is resolved
  let gitRefresh: Promise<GitState | null> | null = null;
  const cached = opts.mode === 'agent' && !opts.resume && opts.gitState !== undefined ? opts.gitState : null;
  if (cached !== null) {
    git = cached;
    gitRefresh = d.probeGitState(root).catch(() => null);
  } else {
    try {
      git = await d.probeGitState(root);
    } catch {
      git = null;
    }
  }
  const gitForMeta = git ?? notRepoState('git-missing', { probedAt: nowIso(), probeMs: 0 });
  const sandbox = d.createSandbox({
    workspaceRoot: root,
    runDir,
    profile: opts.sandboxProfile,
    noNetwork: opts.noNetwork,
    secretReadDenies: opts.secretPaths,
    redact,
    ...(opts.extraWritableRoots ? { extraWritable: opts.extraWritableRoots } : {}),
    ...(opts.extraReadableRoots ? { extraReadable: opts.extraReadableRoots } : {}),
    // contract 1.5 (ORCHESTRATION-DESIGN §5.2 [G3], corner rows 51 / 56): a depth-1 child's profile write-denies the
    // shared git refs (`<commonDir>/refs`, `packed-refs`, `logs`, a linked worktree's HEAD); the depth-0 supervisor
    // must still be able to move `refs/heads/jevcode/<slug>`, so the flag is keyed strictly on depth === 1.
    ...(opts.orchestration?.depth === 1 ? { agentChild: true } : {}),
    // TUI-DESIGN §12.7 / §15 item 18: the seatbelt learns the git dirs and the config dirs from here
    ...(git?.gitDir ? { gitDir: git.gitDir } : {}),
    ...(git?.commonDir ? { gitCommonDir: git.commonDir } : {}),
    ...(opts.configDirs ? { configDirs: opts.configDirs } : {}),
  });
  // TUI-DESIGN §12.1: given the probe, createWorkspace performs zero spawns
  const workspace = await d.createWorkspace(root, runDir, { sandbox, secretPaths: opts.secretPaths, redact, ...(git ? { gitState: git } : {}) });
  const wsInfo = await workspace.info();
  const session = opts.session;
  let headDrift: string | null = null;
  if (resume) {
    // TUI-DESIGN §12.1 / §12.2 (P52): --resume on a different HEAD warns and records `resumedOn`
    const current = resume.meta.git;
    // no comparison when git is unavailable on the resuming machine (probe rejected / not found): a null head is not a moved HEAD
    if (current !== undefined && git !== null && git.repo && headMoved(current.head, git.head)) {
      headDrift = headDriftWarning(current.head, git.head).replace(/^warning: /, '');
      await store.updateMeta({ git: { ...current, resumedOn: git.head } });
    }
  } else {
    const meta: RunMeta = {
      runId,
      task: opts.task,
      workspace: root,
      mode: opts.mode,
      config: opts.configRecord,
      versions: { jevcode: VERSION, node: process.version },
      createdAt: nowIso(),
      overrides: [],
      resumes: [],
      resolvedJevModel: null,
      jevModelDrift: null,
      // TUI-DESIGN §15 item 10 / §15.2 createEngine row: session identity, source, title, the bounded git facts, the instruction files
      sessionId: session?.sessionId ?? runId,
      parentRunId: session?.parentRunId ?? null,
      source: session?.source ?? 'cli',
      ...(session?.title !== undefined ? { title: session.title } : {}),
      git: runGitMetaOf(gitForMeta),
      ...(opts.instructions ? { instructions: opts.instructions.files.map((f) => ({ ...f })) } : {}),
    };
    await store.create(meta);
    // TUI-DESIGN §8.5: run.lock after store.create
    lock = takeRunLock(runDir, runId);
  }
  return new EngineImpl({ runId, opts, store, workspace, sandbox, wsInfo, resume, gitState: git, gitRefresh, runDir, lock: lock ?? { held: false, warning: null }, headDrift, reopened, preflightProbe: d.preflightProbe });
}

/** The run-start dirty paths of a probe, workspace-relative (a workspace below its repository's top level drops the prefix). */
function dirtyPathsOf(g: GitState | null): string[] {
  const prefix = g?.prefix ?? '';
  return (g?.dirty.entries ?? []).map((e) => (prefix.length > 0 && e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path));
}

/**
 * TUI-DESIGN-2 §2.5 / §12: `decider provider changed <from> → <to> (same weights: <openrouter id> ≡ <typesafe id>)` — the EQUIVALENT_IDS
 * row of the run's resolved (or configured) id; the table's first row when the id is an alias (`jev-latest`).
 */
export function providerChangedText(from: string, to: string, id: string): string {
  const row = equivalentIdsRow(id) ?? EQUIVALENT_IDS[0]!;
  return `decider provider changed ${from} → ${to} (same weights: ${row[0]} ≡ ${row[1]})`;
}

/** Effective intent helper exported for tests and the TUI: the safe default of Choice resolution. */
export const DEFAULT_INTENT: Intent = 'investigate';
