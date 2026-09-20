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
import { join, sep } from 'node:path';
import { createEmitter } from '../core/events.js';
import { sha12 } from '../core/hash.js';
import { toJson } from '../core/json.js';
import { monotonicNow, nowIso } from '../core/time.js';
import type { AskResult,
  ActionOutcome,
  Answer,
  CheckpointState,
  CheckpointStore,
  ConfirmRequest,
  Decider,
  Decision,
  Engine,
  EngineEmitter,
  EngineEvent,
  EngineMode,
  EngineOptions,
  EngineStatus,
  FileView,
  GenerateRequest,
  GenerateResult,
  GeneratorCallRecord,
  Intent,
  JevRequestRecord,
  Json,
  JsonObject,
  JudgeResult,
  Plan,
  Proposal,
  Question,
  ReplanDirective,
  RiskAssessment,
  RunCounters,
  RunLimits,
  RunMeta,
  RunResult,
  Sandbox,
  SandboxCreateOptions,
  SerializedError,
  StageName,
  StepRecord,
  StepTiming,
  StepUsage,
  StopReason,
  SynthesisContext,
  Synthesizer,
  TargetInfo,
  TestCounts,
  TokenUsage,
  WindowEntry,
  Workspace,
  WorkspaceInfo,
} from '../core/types.js';
import { AbortError, CheckpointError, ConfigError, GeneratorResponseError, JevModelDriftError, JevResponseError, isAbortError, isBudgetError, isJevCodeError, toJevCodeError } from '../errors.js';
import { decisionConfidence, decisionProbability } from '../jev/confidence.js';
import { assertQuestionBatch } from '../jev/questions.js';
import { summariseAction } from '../provider/actions.js';
import { buildSystemPrompt, type PromptHints, type PromptInput } from '../provider/prompts.js';
import { formatTranscriptItem, itemsFromEvent } from '../tui/plain.js';
import { checkBudgets, armWallDeadline, type WallDeadline } from './budget.js';
import { INTENT_UNRESOLVED_SIGNATURE, computeSignatures, createLoopDetector, loopTripText, type LoopDetector } from './loopdetect.js';
import { applyPlanDraft, emptyPlan, newClaims, type ClaimEvidence } from './plan.js';
import { buildCommonState, type Redact } from './state.js';
import { assembleRunResult, classifyAbort, exitCodeFor, serializeError, stopTranscriptLine, tokenSeriesOrZeros } from './stop.js';
import { buildWindowEntry, foldStepRecord, pushWindow } from './window.js';
import { isComplete } from './stages/complete.js';
import { prefilterCandidates, runContextStage } from './stages/context.js';
import { runExecuteStage } from './stages/execute.js';
import { runIntentStage, INTENT_FALLBACK, PLAN_STALE_THRESHOLD, type IntentStageResult } from './stages/intent.js';
import { runJudgeStage } from './stages/judge.js';
import { runProposeStage } from './stages/propose.js';
import { runReplanStage } from './stages/replan.js';
import { runSynthStage } from './stages/synth.js';
import { computeTargets, runRiskStage, MATCHES_INTENT_THRESHOLD } from './stages/risk.js';

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
export type WorkspaceFactory = (root: string, runDir: string, deps: { sandbox: Sandbox; secretPaths: readonly string[]; redact: Redact }) => Promise<Workspace>;
export type SandboxFactory = (opts: SandboxCreateOptions) => Sandbox;
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
}

interface ResolvedDeps {
  createCheckpointStore: CheckpointStoreFactory;
  createWorkspace: WorkspaceFactory;
  createSandbox: SandboxFactory;
  newRunId: (now: Date) => string;
  loadForResume: ResumeLoader;
}

// Real sibling modules (static imports: esbuild bundles them; tests still inject fakes via EngineDeps).
import { createCheckpointStore as realCreateCheckpointStore } from '../checkpoint/store.js';
import { newRunId as realNewRunId } from '../checkpoint/run-id.js';
import { loadForResume as realLoadForResume } from '../checkpoint/resume.js';
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
  return { createCheckpointStore, createWorkspace, createSandbox, newRunId, loadForResume };
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

// ---------------------------------------------------------------------------------------
// Stage context (what stages/*.ts see)
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
  now(): number;
  wallRemainingMs(): number;
  emit(e: EngineEvent): void;
  ask(stage: StageName, state: JsonObject, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void): Promise<AskOutcome>;
  generate(req: GenerateRequest, attempt: number): Promise<GenerateResult>;
  noteMalformed(attempt: number): void;
  startCandidateRefresh(): void;
}

// ---------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------

interface StepDraft {
  step: number;
  startedAt: string;
  t0: number;
  intent: IntentStageResult | null;
  contextFiles: string[];
  proposal: Proposal | null;
  risk: RiskAssessment | null;
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
  timing: { generatorMs: number; jevMs: number; execMs: number; confirmMs: number };
  generatorFailReason: string | null;
  errorClass: string | null;
  error: { stage: StageName; code: string; message: string } | null;
  interruptedAt: { stage: StageName; reason: 'signal' | 'human_abort' | 'wall_time' | 'error' } | null;
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
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}
function addUsage(a: TokenUsage, b: TokenUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.costUsd += b.costUsd;
  a.calls += b.calls;
}
function zeroTiming(): StepTiming {
  return { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 };
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

function normaliseModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^typesafe\//, '');
}

/** jev-on and jev-only consume Jev answers (intent, context, risk, judge, replan); jev-off is the generator alone (§13). */
export function usesJev(mode: EngineMode): boolean {
  return mode !== 'jev-off';
}

function isPlainStopBudget(reason: StopReason): reason is 'spend_cap' | 'max_steps' | 'wall_time' | 'max_replans' {
  return reason === 'spend_cap' || reason === 'max_steps' || reason === 'wall_time' || reason === 'max_replans';
}

class EngineImpl implements Engine {
  readonly runId: string;
  readonly events: EngineEmitter;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly opts: EngineOptions;
  private readonly mode: EngineMode;
  private readonly redact: Redact;
  private readonly store: CheckpointStore;
  private readonly workspace: Workspace;
  private readonly sandbox: Sandbox;
  private readonly wsInfo: WorkspaceInfo;
  private readonly clock: () => number;
  private readonly systemPrompt: string;
  /** jev-only propose stage; null in the other modes (createEngine rejects jev-only without one) */
  private readonly synthesizer: Synthesizer | null;
  private readonly resumed: boolean;
  private readonly resumeStop: StopReason | null;

  // engine state (§11 state-mutation rule: plan/window/detector change only in commit)
  private step = 0;
  private plan: Plan = emptyPlan();
  private window: WindowEntry[] = [];
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
  private stopReason: StopReason | null = null;
  private stateError: { stage: StageName; code: string } | undefined;
  private interrupted: CheckpointState['interrupted'] = null;
  private consecutiveStageFailures = 0;
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

  constructor(init: {
    runId: string;
    opts: EngineOptions;
    store: CheckpointStore;
    workspace: Workspace;
    sandbox: Sandbox;
    wsInfo: WorkspaceInfo;
    resume: ResumeLoad | null;
  }) {
    this.runId = init.runId;
    this.opts = init.opts;
    this.mode = init.opts.mode;
    this.redact = init.opts.redact;
    this.store = init.store;
    this.workspace = init.workspace;
    this.sandbox = init.sandbox;
    this.wsInfo = init.wsInfo;
    this.clock = init.opts.now ?? monotonicNow;
    this.signal = this.controller.signal;
    this.events = createEmitter((err, event) => {
      // Listener bugs never propagate into the loop; they are reported through the transcript channel.
      if (event.type !== 'transcript') this.events.emit({ type: 'transcript', step: null, level: 'warn', text: `listener error on ${event.type}: ${err instanceof Error ? this.redact(err.message) : String(err)}` });
    });
    this.systemPrompt = buildSystemPrompt({ mode: this.mode, sandboxLevel: init.sandbox.level, toolName: 'propose_action' });
    this.synthesizer = init.opts.synthesizer ?? null;
    this.resumed = init.resume !== null;
    this.resumeStop = null;
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
      this.consecutiveStageFailures = s.consecutiveStageFailures;
      this.jevQuestions = s.jevQuestions ?? 0;
      this.synthState = s.synthState ?? null;
      this.resumes = s.resumes;
      this.jevCalls = s.jevLatencyMs.length;
      this.interrupted = s.interrupted;
      for (const rec of [...init.resume.foldedSteps].sort((a, b) => a.step - b.step)) {
        if (rec.step <= this.step) continue;
        this.window = foldStepRecord(this.window, rec);
        this.step = rec.step;
      }
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
    }
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
    }
  }

  // -------------------------------------------------------------------------------------
  // Engine surface
  // -------------------------------------------------------------------------------------

  status(): EngineStatus {
    return {
      step: this.step,
      maxSteps: this.opts.limits.maxSteps,
      wallMs: this.wallMsUsed(),
      maxWallMs: this.opts.limits.maxWallMs,
      stage: this.currentStage,
      spend: this.opts.meter.snapshot(),
      stopReason: this.stopReason,
    };
  }

  snapshotState(): CheckpointState | null {
    try {
      return this.buildCheckpointState();
    } catch {
      return this.lastSnapshot;
    }
  }

  abort(reason: 'human_abort' | 'signal'): void {
    trace(`abort(${reason}) aborting=${this.aborting} stage=${this.currentStage} step=${this.step} lastResult=${this.lastResult !== null}`);
    // After run() resolved there is nothing to stop and the final checkpoint is already written;
    // installing the 'exit' writer here would leave a listener that rewrites state.json at exit.
    if (this.lastResult !== null) return;
    if (this.aborting) {
      // Second press while shutting down: synchronous last-resort write, then exit (§11).
      if (this.lastResult === null) this.forceExit(reason === 'signal' ? 130 : 130);
      return;
    }
    this.aborting = true;
    if (!this.controller.signal.aborted) this.controller.abort(new AbortError(reason));
    void this.sandbox.killAll().catch(() => undefined);
    const handler = (): void => {
      try {
        const snap = this.snapshotState();
        if (snap) this.store.writeStateSync(snap);
      } catch {
        // nothing more can be done on 'exit'
      }
    };
    this.exitHandler = handler;
    process.on('exit', handler);
  }

  private forceExit(code: number): void {
    try {
      const snap = this.snapshotState();
      if (snap) this.store.writeStateSync(snap);
    } catch {
      // fall through to exit
    }
    const exit = this.opts.exit ?? ((c: number): never => process.exit(c));
    exit(code);
  }

  run(): Promise<RunResult> {
    if (this.finished) return this.finished;
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
    this.emit({ type: 'run:start', runId: this.runId, task: this.opts.task, mode: this.mode, resumedFromStep: this.resumed ? this.step : null });
    if (this.resumeStop !== null) {
      this.emit({ type: 'transcript', step: null, level: 'warn', text: `resume refused: stored stopReason ${this.resumeStop} and its limit was not raised` });
      return this.finish(this.resumeStop, { skipWrite: true });
    }
    this.emit({ type: 'run:ready', runId: this.runId, step: this.step, maxSteps: this.opts.limits.maxSteps, task: this.opts.task, resumed: this.resumed });
    this.runStartMono = this.clock();
    this.deadline = armWallDeadline(this.controller, this.opts.limits.maxWallMs - this.wallMsUsedBefore);
    if (this.resumed) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `resumed at step ${this.step + 1}` });
      this.persist(this.store.updateMeta({ resumes: [{ resumedAt: nowIso(), previousStopReason: this.stopReason }] }), 'run.json');
      this.stopReason = null;
    }
    for (;;) {
      trace(`loop top step=${this.step} aborted=${this.signal.aborted}`);
      if (this.signal.aborted) return this.finish(classifyAbort(this.signal.reason).stop);
      const budget = checkBudgets(this.budgetInput());
      if (budget !== null) {
        this.emit({ type: 'transcript', step: null, level: 'info', text: `budget ${budget} reached at step start` });
        return this.finish(budget);
      }
      const result = await this.runStep();
      trace(`runStep done step=${this.step} stop=${result.stop ?? 'null'}`);
      if (result.stop) return this.finish(result.stop, result.detail ? { detail: result.detail } : {});
    }
  }

  // -------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------

  private emit(e: EngineEvent): void {
    const redacted = redactDeep(e, this.redact) as EngineEvent;
    this.recordTranscript(redacted);
    this.events.emit(redacted);
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
    this.emit({ type: 'status', status: this.status() });
  }

  private persist(p: Promise<void>, what: string): void {
    const tracked: Promise<void> = p
      .catch((e: unknown) => {
        const ev: EngineEvent = { type: 'transcript', step: this.draft?.step ?? null, level: 'warn', text: `${what} write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` };
        // A transcript.log failure is reported to the renderers only; recording it would try the same file again.
        if (what === 'transcript') this.events.emit(redactDeep(ev, this.redact) as EngineEvent);
        else this.emit(ev);
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

  private budgetInput(only?: readonly ('spend_cap' | 'wall_time' | 'max_steps' | 'max_replans')[]): Parameters<typeof checkBudgets>[0] {
    const input: Parameters<typeof checkBudgets>[0] = {
      spendExceeded: this.opts.meter.exceeded(),
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
      consecutiveStageFailures: this.consecutiveStageFailures,
      jevQuestions: this.jevQuestions,
      ...(this.synthState !== null ? { synthState: this.synthState } : {}),
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
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, confirmMs: 0 },
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
    };
  }

  private async stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
    const step = this.draft?.step ?? this.step + 1;
    this.currentStage = name;
    const t0 = this.clock();
    this.emit({ type: 'stage:start', step, stage: name });
    try {
      return await fn();
    } catch (e) {
      trace(`stage ${name} threw ${e instanceof Error ? e.name : typeof e}`);
      throw e;
    } finally {
      trace(`stage ${name} finally`);
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
      ask: (stage, state, questions, annotate) => self.ask(draft, stage, state, questions, annotate),
      generate: (req, attempt) => self.generate(draft, req, attempt),
      noteMalformed: (attempt) => {
        const rec = draft.generatorRecords.find((r) => r.attempt === attempt);
        if (rec) rec.malformed = true;
      },
      startCandidateRefresh: () => {
        self.candidateRefresh = self.workspace.invalidateCandidates().catch((e: unknown) => {
          self.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `candidate refresh failed: ${e instanceof Error ? self.redact(e.message) : String(e)}` });
        });
      },
    };
  }

  // -------------------------------------------------------------------------------------
  // Jev and generator calls (metered here, §6 Budgets)
  // -------------------------------------------------------------------------------------

  private async ask(draft: StepDraft, stage: StageName, state: Json, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void): Promise<AskOutcome> {
    return (await this.askRecorded(draft, stage, state, questions, annotate)).outcome;
  }

  /** The one metered, recorded path to the decider; returns the raw AskResult too for the jev-only decider wrapper. */
  private async askRecorded(draft: StepDraft, stage: StageName, state: Json, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void): Promise<{ outcome: AskOutcome; res: AskResult }> {
    assertQuestionBatch(questions);
    trace(`engine.ask ${stage} step=${draft.step} start`);
    let res: AskResult;
    try {
      res = await this.opts.decider.ask(state, questions, { signal: this.signal, stage, step: draft.step });
    } catch (e) {
      trace(`engine.ask ${stage} rejected ${e instanceof Error ? e.name : typeof e}`);
      throw e;
    }
    trace(`engine.ask ${stage} resolved attempts=${res.attempts}`);
    this.opts.meter.add('jev', res.usage);
    addUsage(draft.usage.jev, res.usage);
    draft.timing.jevMs += res.latencyMs;
    const ids = Object.keys(questions);
    const record: JevRequestRecord = { step: draft.step, stage, requestHash: res.requestHash, latencyMs: res.latencyMs, questions: ids.length, usage: res.usage, model: res.model, attempts: res.attempts };
    draft.jevRequests.push(record);
    this.jevLatencyMs.push(res.latencyMs);
    this.emit({ type: 'jev:request', record });
    this.persist(this.store.appendJevRequest(record), 'jev.jsonl');
    const firstCall = this.jevCalls === 0;
    this.jevCalls += 1;
    const served = this.checkModelDrift(res.model, firstCall, draft.step);
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
   * jev-only (docs/JEV-ONLY.md): what the Synthesizer sees for one step. `emit` is the engine's
   * redacting emit (so `synth` lines reach transcript.log and the renderers); `ask` and
   * `decider.ask` both go through askRecorded (metered, jev.jsonl, decisions.jsonl, the pane,
   * the REPORT question rules), so a synthesizer cannot spend Jev budget or take a decision the
   * run does not record. The signal is the engine's; a synthesizer's own signal is ignored.
   */
  private synthesisContext(draft: StepDraft, contextFiles: readonly FileView[]): SynthesisContext {
    const self = this;
    const decider: Decider = {
      model: this.opts.decider.model,
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
      directive: draft.directive?.text ?? null,
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
    };
  }

  /** §5.4 rule 7. Returns the served id when it must be recorded on the rows, else null. */
  private checkModelDrift(servedRaw: string, firstCall: boolean, step: number): string | null {
    const cfg = normaliseModelId(this.opts.deciderModel.configured);
    const served = normaliseModelId(servedRaw);
    let ok: boolean;
    if (this.resolvedJevModel !== null) ok = served === normaliseModelId(this.resolvedJevModel);
    else if (this.opts.deciderModel.pinned) ok = served === cfg;
    else ok = served.startsWith(cfg);
    if (ok) {
      if (this.resolvedJevModel === null) {
        this.resolvedJevModel = servedRaw;
        this.persist(this.store.updateMeta({ resolvedJevModel: servedRaw }), 'run.json');
        if (!this.opts.deciderModel.pinned) {
          this.emit({ type: 'transcript', step, level: 'warn', text: `jev model alias ${this.opts.deciderModel.configured} resolved to ${servedRaw}; pin it with --jev-model ${servedRaw} for reproducible thresholds` });
        }
      }
      return null;
    }
    const err = new JevModelDriftError(this.opts.deciderModel.configured, servedRaw, { firstCall });
    if (firstCall) {
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

  private async generate(draft: StepDraft, req: GenerateRequest, attempt: number): Promise<GenerateResult> {
    // Defence in depth for docs/JEV-ONLY.md: even with a real provider in the slot, jev-only never reaches it.
    if (this.mode === 'jev-only') throw new ConfigError('jev-only mode: the generating LLM must not be called', { setting: 'mode' });
    this.emit({ type: 'generator:start', step: draft.step, attempt });
    // Tool-call argument fragments are reported as a cumulative character count per call; the
    // renderer coalesces ("streaming action… N chars", §7/§10). The text itself is parsed once at the end.
    let toolChars = 0;
    const res = await this.opts.provider.generate(req, {
      signal: this.signal,
      onDelta: (text) => this.emit({ type: 'generator:delta', step: draft.step, text }),
      onToolDelta: (fragment) => {
        toolChars += fragment.length;
        this.emit({ type: 'generator:tool-delta', step: draft.step, chars: toolChars });
      },
    });
    this.opts.meter.add('generator', res.usage);
    addUsage(draft.usage.generator, res.usage);
    draft.timing.generatorMs += res.latencyMs;
    draft.generatorRecords.push({
      step: draft.step,
      attempt,
      promptHash: sha12(toJson({ system: req.system, messages: req.messages })),
      model: res.model,
      temperature: this.opts.generation.temperature,
      maxTokens: this.opts.generation.maxTokens,
      usage: res.usage,
      latencyMs: res.latencyMs,
      stopReason: res.stopReason,
      malformed: false,
    });
    this.emit({ type: 'generator:end', step: draft.step, usage: res.usage, latencyMs: res.latencyMs, finishReason: res.stopReason });
    return res;
  }

  // -------------------------------------------------------------------------------------
  // One step
  // -------------------------------------------------------------------------------------

  private async runStep(): Promise<{ stop: StopReason | null; detail?: string }> {
    const step = this.step + 1;
    const draft = this.newDraft(step);
    this.draft = draft;
    this.emit({ type: 'step:start', step, startedAt: draft.startedAt });
    let stage: StageName = usesJev(this.mode) ? (this.detector.tripped() ? 'replan' : 'intent') : 'propose';
    let changedFiles: string[] = [];
    let stopAfterCommit: StopReason | null = null;
    let commonState: JsonObject | null = null;
    const claimsOf = (proposal: Proposal): void => {
      const c = newClaims(this.plan, proposal.plan);
      draft.claims = c.claims;
      draft.claimsDropped = c.dropped;
    };
    try {
      changedFiles = await this.workspace.changedFiles().catch(() => [] as string[]);
      const ctx = this.makeContext(draft, changedFiles);
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
          draft.directive = r.directive;
        }
        stage = 'intent';
        draft.intent = await this.stage('intent', () => runIntentStage(ctx, common()));
        if (draft.intent.verdict === 'fallback') draft.observed = true;
        stage = 'context';
        const intentInfo = { intent: draft.intent.intent, answer: draft.intent.answer, probability: draft.intent.probability };
        const cx = await this.stage('context', () => runContextStage(ctx, common(), intentInfo));
        draft.contextFiles = cx.files.map((f) => f.path);
        stage = 'propose';
        let p: { proposal: Proposal };
        if (this.mode === 'jev-only') {
          // The Synthesizer proposes (docs/JEV-ONLY.md): no generator call, no generator:* events, no generator.jsonl row.
          const synthesizer = this.synthesizer;
          if (synthesizer === null) throw new ConfigError('jev-only mode requires a synthesizer', { setting: 'mode' });
          const sctx = this.synthesisContext(draft, cx.files);
          p = await this.stage('propose', () => runSynthStage(ctx, synthesizer, sctx));
        } else {
          const prompt = this.promptInput(draft, changedFiles, cx.files, null);
          p = await this.stage('propose', () => runProposeStage(ctx, this.systemPrompt, prompt));
          this.flushGeneratorRecords(draft);
        }
        draft.proposal = p.proposal;
        draft.proposeCompleted = true;
        claimsOf(p.proposal);
        stage = 'risk';
        const rk = await this.stage('risk', () => runRiskStage(ctx, common(), p.proposal, intentInfo));
        draft.risk = rk.risk;
        draft.matchesIntent = rk.matchesIntent;
        draft.patchTargets = rk.targets;
        if (rk.risk.verdict === 'block') {
          draft.outcome = { status: 'blocked', reason: rk.risk.reason };
          this.counters.blocked += 1;
          this.emit({ type: 'outcome', step, outcome: draft.outcome });
        } else if (rk.risk.verdict === 'review') {
          const approved = await this.confirm(draft, p.proposal, rk.risk);
          // Counted only once the review resolved: an abort while it is pending discards the step
          // (§9.1 rule 1) and the resumed run asks again, so counting early would double it.
          this.counters.reviews += 1;
          if (!approved) {
            const identity = this.opts.confirmer.identity;
            const reason = identity === 'reviewer' ? `declined by reviewer: ${rk.risk.reason}` : `not approved (${identity}): ${rk.risk.reason}`;
            draft.outcome = { status: 'declined', reason };
            this.counters.declined += 1;
            this.emit({ type: 'outcome', step, outcome: draft.outcome });
          }
        }
      } else {
        stage = 'propose';
        // Same <= 300 pre-filter (mention count, then recency) as the context stage (§13).
        const listing = await this.workspace.listCandidates().catch(() => []);
        const candidates = prefilterCandidates(this.opts.task, listing, new Set([...changedFiles, ...this.createdThisRun]));
        const prompt = this.promptInput(draft, changedFiles, [], candidates);
        const p = await this.stage('propose', () => runProposeStage(ctx, this.systemPrompt, prompt));
        this.flushGeneratorRecords(draft);
        draft.proposal = p.proposal;
        draft.proposeCompleted = true;
        claimsOf(p.proposal);
        stage = 'execute';
        draft.patchTargets = await computeTargets(ctx, p.proposal);
      }

      if (draft.outcome === null && draft.proposal !== null) {
        // Await the overlapped checkpoint of the previous step before anything touches the workspace (§9).
        if (this.pendingCheckpoint) await this.pendingCheckpoint;
        const b = checkBudgets(this.budgetInput(['spend_cap', 'wall_time']));
        if (b !== null) {
          this.interrupted = { step, stage: 'execute', proposal: draft.proposal };
          this.emit({ type: 'transcript', step, level: 'info', text: `budget ${b} reached before execute; step ${step} discarded` });
          this.absorbDiscardedTiming(draft);
          return { stop: b, detail: 'before_execute' };
        }
        stage = 'execute';
        draft.executeStarted = true;
        const ex = await this.stage('execute', () => runExecuteStage(ctx, draft.proposal!));
        draft.outcome = ex.outcome;
        draft.output = ex.output;
        draft.changedFiles = ex.changedFiles;
        draft.tests = ex.tests;
        draft.created = ex.created;
        draft.timing.execMs += ex.execMs;
        draft.executeFinished = true;
        this.emit({ type: 'outcome', step, outcome: ex.outcome });
        if (ex.outcome.status === 'interrupted') {
          const cls = classifyAbort(this.signal.reason);
          draft.interruptedAt = { stage: 'execute', reason: cls.interrupt };
          draft.observed = false;
          stopAfterCommit = cls.stop;
        } else if (usesJev(this.mode)) {
          stage = 'judge';
          const recent = pushWindow(this.window, this.provisionalEntry(draft));
          const judgeCommon = this.commonState(await this.workspace.changedFiles().catch(() => changedFiles), recent, draft);
          const j = await this.stage('judge', () =>
            runJudgeStage(ctx, judgeCommon, draft.proposal!, { outcome: ex.outcome, output: ex.output, changedFiles: ex.changedFiles, tests: ex.tests }, draft.claims),
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
    const committed = this.commit(draft);
    if (committed.stop) return { stop: committed.stop };
    if (stopAfterCommit) return { stop: stopAfterCommit };
    if (usesJev(this.mode) && isComplete(draft.completion, this.opts.limits.completeThreshold)) return { stop: 'complete' };
    if (this.mode === 'jev-off' && draft.outcome?.status === 'noop') return { stop: 'generator_done' };
    if (this.consecutiveStageFailures >= CONSECUTIVE_STAGE_FAILURE_LIMIT) {
      const err = draft.error ?? { stage, code: 'internal' };
      this.stateError = { stage: err.stage, code: err.code };
      return { stop: 'error' };
    }
    return { stop: null };
  }

  private flushGeneratorRecords(draft: StepDraft): void {
    for (const rec of draft.generatorRecords) this.persist(this.store.appendGenerator(rec), 'generator.jsonl');
    draft.generatorRecords = [];
  }

  private absorbDiscardedTiming(draft: StepDraft): void {
    // Discarded steps (§9.1 rule 1) still consumed wall time and money; the run totals keep them.
    this.flushGeneratorRecords(draft);
    const total = Math.max(0, this.clock() - draft.t0);
    this.timing.generatorMs += draft.timing.generatorMs;
    this.timing.jevMs += draft.timing.jevMs;
    this.timing.execMs += draft.timing.execMs;
    this.timing.totalMs += total;
    this.timing.harnessMs += Math.max(0, total - draft.timing.generatorMs - draft.timing.jevMs - draft.timing.execMs - draft.timing.confirmMs);
  }

  private async confirm(draft: StepDraft, proposal: Proposal, risk: RiskAssessment): Promise<boolean> {
    const req: ConfirmRequest = { id: `${this.runId}:${draft.step}`, step: draft.step, proposal, risk };
    this.emit({ type: 'confirm:request', request: req });
    const c0 = this.clock();
    try {
      const approved = await this.opts.confirmer.confirm(req, { signal: this.signal });
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved, aborted: false });
      return approved;
    } catch (e) {
      draft.timing.confirmMs += Math.max(0, this.clock() - c0);
      this.emit({ type: 'confirm:resolved', step: draft.step, id: req.id, approved: false, aborted: true });
      // A confirmer abort without an engine abort (renderer-side Ctrl-C) is a human abort.
      if (isAbortError(e) && !this.signal.aborted) this.abort(e.reason === 'signal' ? 'signal' : 'human_abort');
      throw e;
    }
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
    };
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
      const cls = classifyAbort(this.signal.aborted ? this.signal.reason : e);
      if (this.fatalError !== null) cls.stop = 'error';
      if (!draft.executeStarted) {
        // Rule 1: the step is discarded; the proposal is kept for the transcript.
        this.interrupted = { step: draft.step, stage, proposal: draft.proposal };
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
      return { discard: false, stop: cls.stop };
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
    const proposal = draft.proposal;
    const outcome = draft.outcome;
    const status = outcome?.status ?? null;
    const evidence: ClaimEvidence = (() => {
      if (proposal === null) return { kind: 'none', because: 'no proposal' };
      if (this.mode === 'jev-off') return status === 'executed' || status === 'noop' ? { kind: 'verbatim' } : { kind: 'none', because: `outcome ${status ?? 'none'}` };
      if (draft.claimProbabilities !== null && draft.judge !== null) return { kind: 'judged', probabilities: draft.claimProbabilities };
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
    });
    let plan = update.plan;
    const notes = [...draft.notes, ...update.notes];
    if (status === 'noop' && usesJev(this.mode) && draft.completion !== null && !isComplete(draft.completion, this.opts.limits.completeThreshold)) {
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
    if (draft.tests?.parsed) {
      this.lastTestRun = { step, command: draft.tests.command, passed: draft.tests.parsed.passed, failed: draft.tests.parsed.failed, errors: draft.tests.parsed.errors, allPassed: draft.tests.allPassed === true };
    }
    for (const p of draft.created) this.createdThisRun.add(p);
    if (status === 'executed' && proposal?.action.kind === 'read') this.counters.reads += 1;

    // Timing and usage.
    const total = Math.max(0, this.clock() - draft.t0);
    const timing: StepTiming = {
      generatorMs: draft.timing.generatorMs,
      jevMs: draft.timing.jevMs,
      execMs: draft.timing.execMs,
      harnessMs: Math.max(0, total - draft.timing.generatorMs - draft.timing.jevMs - draft.timing.execMs - draft.timing.confirmMs),
      totalMs: total,
    };
    this.timing.generatorMs += timing.generatorMs;
    this.timing.jevMs += timing.jevMs;
    this.timing.execMs += timing.execMs;
    this.timing.harnessMs += timing.harnessMs;
    this.timing.totalMs += timing.totalMs;
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
    const signatures = computeSignatures({
      proposal,
      outcome,
      output: draft.output.length > 0 ? draft.output : null,
      intentFallback: draft.intent?.verdict === 'fallback',
      generatorFailReason: draft.generatorFailReason,
      errorClass: draft.errorClass,
      observed: draft.observed,
      workspaceRoot: this.workspace.root,
    });
    const trip = this.detector.observe(step, signatures);
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

    // Hints for the next prompt.
    if (draft.matchesIntent !== null && draft.matchesIntent < MATCHES_INTENT_THRESHOLD && draft.intent) this.nextHints.intentMismatch = { intent: draft.intent.intent, probability: draft.matchesIntent, step };
    if (draft.claimsDropped > 0) this.nextHints.claimsDropped = draft.claimsDropped;

    // §6: only a step WITHOUT a stage failure resets the counter; three consecutive steps with one stop the run with 'error'.
    if (draft.error === null) this.consecutiveStageFailures = 0;
    this.jevQuestions += draft.decisions.length;

    this.step = step;
    this.plan = plan;
    this.window = window;
    this.interrupted = null;
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
      usage: draft.usage,
      timing,
      loopSignatures: signatures,
    };
    if (draft.interruptedAt) record.interruptedAt = draft.interruptedAt;
    if (draft.error) record.error = draft.error;
    if (usesJev(this.mode) && isComplete(draft.completion, this.opts.limits.completeThreshold)) record.stoppedAt = 'complete';
    else if (checkBudgets(this.budgetInput()) !== null) record.stoppedAt = 'step_start';

    const snapshot = this.buildCheckpointState();
    const c0 = this.clock();
    this.pendingCheckpoint = (async () => {
      try {
        await this.store.appendStep(record);
        await this.store.writeState(snapshot);
        this.emit({ type: 'checkpoint', step, ms: Math.max(0, this.clock() - c0) });
      } catch (e) {
        this.emit({ type: 'error', step, error: serializeError(e, this.redact), fatal: false });
      }
    })();
    this.emit({ type: 'step:end', record });
    this.emitStatus();
    this.draft = null;
    this.currentStage = 'idle';
    return { stop: null };
  }

  // -------------------------------------------------------------------------------------
  // Single exit path (§6 stop, §11 shutdown)
  // -------------------------------------------------------------------------------------

  private async finish(reason: StopReason, opts: { detail?: string; skipWrite?: boolean } = {}): Promise<RunResult> {
    trace(`finish(${reason}) pendingCheckpoint=${this.pendingCheckpoint !== null} persists=${this.pendingPersists.size}`);
    if (this.lastResult) return this.lastResult;
    this.deadline?.clear();
    this.currentStage = 'idle';
    this.stopReason = reason;
    let error: SerializedError | null = null;
    if (reason === 'error') {
      const src = this.fatalError ?? this.lastStageError;
      if (src !== null) error = serializeError(src, this.redact);
      if (isJevCodeError(src) && !this.stateError) this.stateError = { stage: this.lastErrorStage ?? 'intent', code: src.code };
    }
    const snapshot = this.buildCheckpointState();
    const result = assembleRunResult({ runId: this.runId, mode: this.mode, reason, state: snapshot, error });
    const stopLine: EngineEvent = { type: 'transcript', step: null, level: reason === 'complete' ? 'info' : 'warn', text: stopTranscriptLine(reason, this.step, opts.detail) };
    // Pre-redacted so the line written before flush is the very event the renderers receive last.
    const endEvent = redactDeep({ type: 'run:end', result } satisfies EngineEvent, this.redact) as EngineEvent;
    let stopEmitted = false;
    if (!opts.skipWrite) {
      const phase = (async (): Promise<void> => {
        // Stray background process groups from a successful run must not outlive it (§8); abort() already killed on its path.
        if (!this.aborting) await this.sandbox.killAll().catch(() => undefined);
        if (this.pendingCheckpoint) await this.pendingCheckpoint;
        trace('finish: checkpoint awaited, writing final state');
        await this.store.writeState(snapshot);
        trace('finish: final state written');
        // The stop line and the run:end line reach transcript.log through the same item model as every other line (§10).
        stopEmitted = true;
        this.emit(stopLine);
        this.recordTranscript(endEvent);
        await Promise.allSettled([...this.pendingPersists]);
        await this.store.flush();
      })();
      let timer: NodeJS.Timeout | null = null;
      const bound = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SHUTDOWN_CHECKPOINT_BOUND_MS);
        timer.unref();
      });
      const outcome = await Promise.race([phase.then(() => 'ok' as const, () => 'failed' as const), bound]);
      trace(`finish: phase outcome ${outcome}`);
      if (timer) clearTimeout(timer);
      // Renderer-only notices: the run:end line is already recorded, and a failing store cannot take another line anyway.
      if (outcome === 'timeout') {
        this.events.emit({ type: 'transcript', step: null, level: 'error', text: `final checkpoint exceeded ${SHUTDOWN_CHECKPOINT_BOUND_MS} ms; writing state synchronously and exiting` });
        try {
          this.forceExit(exitCodeFor(reason, error ?? undefined));
        } catch {
          // an injected exit that throws (tests) must not re-enter the stop path
        }
      } else if (outcome === 'failed') {
        this.events.emit({ type: 'transcript', step: null, level: 'error', text: 'final checkpoint write failed' });
      }
    }
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.lastResult = result;
    if (!stopEmitted) this.emit(stopLine);
    this.emitStatus();
    // Already recorded in the checkpoint phase (or muted); emitted raw so it is not written twice.
    this.events.emit(endEvent);
    return result;
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

export async function createEngine(opts: EngineOptions, deps: EngineDeps = {}): Promise<Engine> {
  if (opts.mode === 'jev-only' && !opts.synthesizer) throw new ConfigError('jev-only mode requires a synthesizer (EngineOptions.synthesizer)', { setting: 'mode' });
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
  if (opts.resume) {
    runId = opts.resume.runId;
    await validateResumeId(opts.runsDir, runId);
    store = d.createCheckpointStore(opts.runsDir, runId, redact);
    resume = await d.loadForResume(opts.runsDir, runId, redact, store);
    if (resume.store) store = resume.store;
    if (resume.state.runId !== runId) throw new CheckpointError(`state.json belongs to run ${resume.state.runId}, not ${runId}`, store.dir);
    if (resume.state.mode !== opts.mode) throw new ConfigError(`--resume: run ${runId} was a ${resume.state.mode} run`, { setting: 'mode' });
    if ((resume.previousStopReason ?? resume.state.stopReason) === 'complete' && !opts.resume.force) throw new ConfigError(`--resume: run ${runId} is complete; pass --force to continue it`, { setting: 'resume' });
  } else {
    runId = await createRunDir(opts.runsDir, d.newRunId);
    store = d.createCheckpointStore(opts.runsDir, runId, redact);
    const meta: RunMeta = {
      runId,
      task: opts.task,
      workspace: root,
      mode: opts.mode,
      config: opts.configRecord,
      versions: { jevcode: process.env['npm_package_version'] ?? '0.1.0', node: process.version },
      createdAt: nowIso(),
      overrides: [],
      resumes: [],
      resolvedJevModel: null,
      jevModelDrift: null,
    };
    await store.create(meta);
  }
  const runDir = store.dir || join(opts.runsDir, runId);
  const sandbox = d.createSandbox({
    workspaceRoot: root,
    runDir,
    profile: opts.sandboxProfile,
    noNetwork: opts.noNetwork,
    secretReadDenies: opts.secretPaths,
    redact,
    ...(opts.extraWritableRoots ? { extraWritable: opts.extraWritableRoots } : {}),
    ...(opts.extraReadableRoots ? { extraReadable: opts.extraReadableRoots } : {}),
  });
  const workspace = await d.createWorkspace(root, runDir, { sandbox, secretPaths: opts.secretPaths, redact });
  const wsInfo = await workspace.info();
  return new EngineImpl({ runId, opts, store, workspace, sandbox, wsInfo, resume });
}

/** Effective intent helper exported for tests and the TUI: the safe default of Choice resolution. */
export const DEFAULT_INTENT: Intent = 'investigate';
