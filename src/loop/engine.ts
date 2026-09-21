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
import { join, sep } from 'node:path';
import { createEmitter } from '../core/events.js';
import { sha12 } from '../core/hash.js';
import { toJson } from '../core/json.js';
import { clip } from '../core/text.js';
import { monotonicNow, nowIso, sleep } from '../core/time.js';
// TUI-DESIGN §8.6 (F7): the steer bounds are defined once, next to PendingDirective; re-exported below under the engine's names
import { DIRECTIVE_MAX_CHARS, PENDING_DIRECTIVES_MAX } from '../core/types.js';
import type { AskResult,
  Action,
  ActionOutcome,
  Answer,
  BlockingAnswer,
  BlockingRequest,
  CheckpointState,
  ConfirmOutcome,
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
  GitState,
  HarnessProblem,
  Intent,
  IntentAnswer,
  JevRequestRecord,
  Json,
  JsonObject,
  JudgeResult,
  PendingDirective,
  Plan,
  PlanSnapshot,
  StepProposer,
  Proposal,
  Question,
  ReplanDirective,
  RetryInfo,
  RiskAssessment,
  RunCounters,
  RunGitMeta,
  RunLimits,
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
  StepRecord,
  StepTiming,
  StepUsage,
  StopReason,
  StoppedAt,
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
} from '../core/types.js';
import { AbortError, CheckpointError, ConfigError, GeneratorResponseError, JevCodeError, JevHttpError, JevModelDriftError, JevResponseError, ProviderHttpError, isAbortError, isBudgetError, isJevCodeError, toJevCodeError, type BudgetKind } from '../errors.js';
import { CHECKPOINT_FILES, classifyDiskError } from '../checkpoint/store.js';
import { writePostImages, writePreImages, type ImageSource, type PreImageResult } from '../checkpoint/images.js';
import { acquireRunLock, releaseRunLock } from '../session/lock.js';
import { seedNoticeText } from '../session/seed.js';
import { nextBudgetWarn, seedAnnounced, stepsLeftEstimate, suggestedSpendCapUsd, type BudgetPct } from '../tui/budget/lines.js';
import { checkpointDegradedDetail, driftDetail, keyRejectedDetail } from '../tui/blocking/lines.js';
import { VERSION } from '../version.js';
import { headDriftWarning, headMoved, notRepoState, probeGitState as realProbeGitState, toRunGitMeta } from '../workspace/gitstate.js';
import { decisionConfidence, decisionProbability } from '../jev/confidence.js';
import { assertQuestionBatch } from '../jev/questions.js';
import { summariseAction } from '../provider/actions.js';
import { buildSystemPrompt, type PromptHints, type PromptInput } from '../provider/prompts.js';
import { linkedAbort } from '../core/abort.js';
import { lookupPricing } from '../config/defaults.js';
import { formatTranscriptItem, itemsFromEvent, sanitizeStream } from '../tui/plain.js';
import { checkBudgets, armWallDeadline, type WallDeadline } from './budget.js';
import { INTENT_UNRESOLVED_SIGNATURE, computeSignatures, createLoopDetector, directiveMove, loopTripText, signatureKind, type LoopDetector } from './loopdetect.js';
import { PLAN_MAX_HARNESS_PROBLEMS, applyPlanDraft, boundHarnessProblems, emptyPlan, newClaims, type ClaimEvidence } from './plan.js';
import { buildCommonState, testsCurrent, type Redact } from './state.js';
import { assembleRunResult, classifyAbort, exitCodeFor, serializeError, stopTranscriptLine, tokenSeriesOrZeros } from './stop.js';
import { buildWindowEntry, foldStepRecord, pushWindow } from './window.js';
import { isComplete, isCompleteByFact, type CompletionFactInput } from './stages/complete.js';
import { prefilterCandidates, runContextStage } from './stages/context.js';
import { runExecuteStage } from './stages/execute.js';
import { runIntentStage, INTENT_FALLBACK, PLAN_STALE_THRESHOLD, type IntentStageResult } from './stages/intent.js';
import { runJudgeStage } from './stages/judge.js';
import { runProposeStage } from './stages/propose.js';
import { runReplanStage } from './stages/replan.js';
import { runSynthStage } from './stages/synth.js';
import { computeTargets, runRiskStage, MATCHES_INTENT_THRESHOLD, type VerifiedCompletion } from './stages/risk.js';

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
}

interface ResolvedDeps {
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
  const probeGitState: GitProbe = deps.probeGitState ?? ((root) => realProbeGitState(root));
  return { createCheckpointStore, createWorkspace, createSandbox, newRunId, loadForResume, probeGitState };
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

/**
 * TUI-DESIGN §13.3: what a failing stage asks for, before the loop top installs it. The id and the auto-retry interval
 * are allocated only at install time (`installBlock`), so a request handleStepError discards (an action already ran, a
 * pane is already up) advances neither the blocking sequence nor the `jev-unreachable` backoff.
 */
type BlockSpec = Omit<BlockingRequest, 'id' | 'retryInMs'> & { autoRetry?: boolean };

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
  /** imagesMs: TUI-DESIGN §12.3 pre + post images, inside harnessMs; null when the step took none */
  timing: { generatorMs: number; jevMs: number; execMs: number; confirmMs: number; imagesMs: number | null };
  /** docs/LLM-JEV-DESIGN.md §7.5: wall of synthesize() (synth modes); null when the propose stage was the generator's */
  synthMs: number | null;
  /** the Jev latency spent inside synthesize(); `timing.jevMs - synthJevMs` is the shell's share */
  synthJevMs: number;
  /** docs/LLM-JEV-DESIGN.md §4.8: the in-flight samples of the llm-jev round, for the batch wall in `timing.generatorMs` */
  generatorBatch: { inFlight: number; startedAt: number };
  /** docs/LLM-JEV-DESIGN.md §9.4 (llm-jev): who proposed — the synthesizer, or the generic per-step fallback (stage 4); null in the other modes */
  proposer: StepProposer | null;
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

/**
 * jev-on and jev-only consume Jev answers (intent, context, risk, judge, replan); jev-off is the generator alone (§13).
 * llm-jev is true here too (docs/LLM-JEV-DESIGN.md §6.3) while every intent/context/judge branch it guards is edited to
 * skip or compute in that mode: replan on a trip, harm-only risk, code judge, code completion.
 */
export function usesJev(mode: EngineMode): boolean {
  return mode !== 'jev-off';
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
  /** a provider reported usage without a finite cost (§9.5): the run stops with error after the step commits unless --allow-unpriced */
  private unpriced: { side: SpendSource; model: string; stage: StageName } | null = null;
  /** `budget:unpriced` is one item per (side, model) per run (§9.5), not one per metered call */
  private readonly unpricedAnnounced = new Set<string>();
  /** finish() is in flight (the final snapshot is built): steer/unsteer/pause/annotate read as finished so nothing is confirmed and then dropped (§8.6) */
  private finishing = false;
  /** the run-start probe (§12.1); null when the probe was unavailable */
  private readonly gitState: GitState | null;
  private readonly gitMeta: RunGitMeta;
  /** paths dirty at run start (top-level relative, prefix stripped): a changed file outside it was clean at start (§12.3 cleanAtStart) */
  private readonly dirtyAtStart: ReadonlySet<string>;
  private readonly runDir: string;
  private lockHeld: boolean;
  /** notices decided before run(): the stale-lock replacement, the HEAD-drift warning; emitted after run:ready so every writer sees them */
  private readonly startupNotices: { kind: 'lock' | 'drift'; level: 'warn'; text: string }[] = [];
  /**
   * TUI-DESIGN §8.6 / §15.2: steer, unsteer, pause and secret-ack items decided before run() (EngineOptions.humanDirective
   * included) are announced after run:ready in the order they happened, so every writer sees run:start first.
   */
  private deferredAnnouncements: EngineEvent[] = [];

  constructor(init: {
    runId: string;
    opts: EngineOptions;
    store: CheckpointStore;
    workspace: Workspace;
    sandbox: Sandbox;
    wsInfo: WorkspaceInfo;
    resume: ResumeLoad | null;
    gitState: GitState | null;
    runDir: string;
    lock: { held: boolean; warning: string | null };
    headDrift: string | null;
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
    // TUI-DESIGN §15.2 constructor row: AGENTS.md text reaches the generator system prompt only (D6)
    const instructions = init.opts.instructions?.text ?? '';
    this.systemPrompt = buildSystemPrompt({ mode: this.mode, sandboxLevel: init.sandbox.level, toolName: 'propose_action', ...(instructions.length > 0 ? { instructions } : {}) });
    this.synthesizer = init.opts.synthesizer ?? null;
    this.resumed = init.resume !== null;
    this.resumeStop = null;
    this.gitState = init.gitState;
    this.gitMeta = runGitMetaOf(init.gitState ?? notRepoState('git-missing', { probedAt: nowIso(), probeMs: 0 }));
    const prefix = init.gitState?.prefix ?? '';
    this.dirtyAtStart = new Set((init.gitState?.dirty.entries ?? []).map((e) => (prefix.length > 0 && e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path)));
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
      this.consecutiveStageFailures = s.consecutiveStageFailures;
      this.jevQuestions = s.jevQuestions ?? 0;
      this.synthState = s.synthState ?? null;
      this.resumes = s.resumes;
      this.jevCalls = s.jevLatencyMs.length;
      this.interrupted = s.interrupted;
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
        this.lastTestRun = seed.lastTestRun ? { ...seed.lastTestRun } : null;
        this.lastChangeStep = null;
        this.undoLog = [...(seed.undoLog ?? []), ...(init.opts.undoLog ?? [])].slice(-UNDO_LOG_MAX);
        this.seeded = true;
      } else {
        this.undoLog = [...(init.opts.undoLog ?? [])].slice(-UNDO_LOG_MAX);
      }
    }
    this.restoredSpentUsd = restoredSpentUsd;
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

  status(): EngineStatus {
    return {
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
    };
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
      // `interrupted` for the discarded step (observed in the first live TUI session, docs/live/tui).
      if (this.lastResult === null) {
        this.markLastResort(reason);
        this.forceExit(exitCodeFor('signal', undefined, false, this.signalName ?? undefined));
      }
      return;
    }
    this.aborting = true;
    if (!this.controller.signal.aborted) this.controller.abort(new AbortError(reason, this.signalName));
    void this.sandbox.killAll().catch(() => undefined);
    const handler = (): void => {
      try {
        // the process is exiting before finish() completed: record the stop and the discarded step (§9.1 rule 1)
        this.markLastResort(reason);
        const snap = this.snapshotState();
        if (snap) this.store.writeStateSync(snap);
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
    if (this.stopReason === null) this.stopReason = reason;
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

  /** Stop with 'human_pause' at the next loop top (§9.1 rule 1: the in-flight step commits whole first); idempotent. */
  pause(): void {
    if (this.pauseRequested || this.isFinished()) return;
    this.pauseRequested = true;
    this.announce([{ type: 'pause:requested', step: this.step + 1 }]);
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
   * A renderer-originated transcript line while the run is live (§15.1): it rides the engine's redacting
   * emit and transcriptSeq, so transcript.log, --plain and the TUI stay line-identical. False once the run
   * finished (or before it started): the renderer then keeps the item local.
   */
  annotate(text: string, opts: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' } = {}): boolean {
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
      level: opts.level ?? 'info',
      text: clipText(sanitizeStream(text), ANNOTATE_TEXT_MAX_CHARS),
      label: opts.label ?? '[ui]',
      ...(detail.length > 0 ? { detail } : {}),
    });
    return true;
  }

  run(): Promise<RunResult> {
    if (this.finished) return this.finished;
    this.started = true;
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
    // TUI-DESIGN §12.2: the git banner and the instruction files as one event right after run:ready (notice-only, never a gate)
    this.emit({ type: 'workspace', git: this.gitMeta, instructions: (this.opts.instructions?.files ?? []).map((f) => ({ ...f })), sandbox: this.sandbox.level });
    for (const n of this.startupNotices) this.emit({ type: 'notice', step: null, kind: n.kind, level: n.level, text: n.text });
    // TUI-DESIGN §9.3: the clamp is an engine item so all three writers carry it
    if (session?.clamp) this.emit({ type: 'budget:clamp', runCapUsd: session.clamp.runCapUsd, clampedToUsd: session.clamp.clampedToUsd, sessionSpentUsd: session.clamp.sessionSpentUsd, sessionCapUsd: session.clamp.sessionCapUsd });
    // TUI-DESIGN §9.4: one budget:override per override the controller computed for THIS resume (EngineOptions.resumeOverrides);
    // they are appended to run.json.overrides[] below with the resumes[] entry — never re-derived from run.json
    const resumeOverrides = this.resumed ? (this.opts.resumeOverrides ?? []) : [];
    for (const o of resumeOverrides) this.emit({ type: 'budget:override', setting: o.setting, from: o.from, to: o.to, appliesTo: 'resume', source: o.source ?? 'flag' });
    // TUI-DESIGN §8.3: the seeded line names the parent and what was carried
    if (this.seeded && this.opts.seed) this.emit({ type: 'notice', step: null, kind: 'seeded', level: 'info', text: seedNoticeText(this.opts.seed, this.opts.seed.carriedDirectives ?? 0) });
    // TUI-DESIGN §10.2: the count of secrets the human sent on request (never the values)
    if (this.opts.secretsAcked !== undefined && this.opts.secretsAcked > 0) this.emit({ type: 'secret-ack', step: null, count: this.opts.secretsAcked });
    // TUI-DESIGN §8.6 / §15.2: steers, withdrawals, a pause and secret-acks decided before run(), in order, after every writer saw run:ready
    this.flushDeferredAnnouncements();
    this.runStartMono = this.clock();
    this.deadline = armWallDeadline(this.controller, this.opts.limits.maxWallMs - this.wallMsUsedBefore);
    if (this.resumed) {
      this.emit({ type: 'transcript', step: null, level: 'info', text: `resumed at step ${this.step + 1}` });
      // TUI-DESIGN §9.4: this resume's overrides are recorded in run.json together with its resumes[] entry
      this.persist(
        this.store.updateMeta({ resumes: [{ resumedAt: nowIso(), previousStopReason: this.stopReason }], ...(resumeOverrides.length > 0 ? { overrides: resumeOverrides.map((o) => ({ ...o })) } : {}) }),
        CHECKPOINT_FILES.meta,
      );
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
      // contract 1.1 (TUI-DESIGN §9.1, §15.2): a requested pause ends the run only here, after the in-flight step committed whole
      if (this.pauseRequested) return this.finish('human_pause');
      // TUI-DESIGN §13.3: every blocking pause is awaited here — nothing is in flight and the last commit is whole
      if (this.blocked !== null) {
        const req = this.blocked;
        const answer = await this.awaitBlocker(req);
        if (this.signal.aborted) continue; // the abort is classified at the top
        // TUI-DESIGN §13.3: the drift pane offers `[p] pin … for the next run` and `[q] stop` only — every answer ends the run with
        // exit 2 (a `retry` would re-run on the drifted model: the second call is no longer a first call)
        if (answer === 'stop' || req.kind === 'drift') {
          this.adoptBlockedError(req);
          return this.finish(req.stop);
        }
        this.blocked = null;
        this.blockedError = null;
        if (req.kind === 'checkpoint-degraded') {
          if (answer === 'continue') this.checkpointDegraded = true;
          else await this.retryStateWrite(req.step);
        }
        this.emitStatus();
        continue; // re-check abort, budgets and pause before the next step
      }
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
      try {
        ({ answer, auto } = await Promise.race(races));
        // a `[r] now` press (retryNow aborted the waker) ended the wait early: a retry answered by the human, not by the timer
        if (auto && waker !== null && waker.signal.aborted) auto = false;
      } catch {
        answer = 'stop';
      } finally {
        if (onAbort !== null) this.signal.removeEventListener('abort', onAbort);
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
    if (!this.warned.has(disk.key)) {
      this.warned.add(disk.key);
      this.emit({ type: 'notice', step, kind: 'checkpoint:degraded', level: 'error', text: disk.text });
    }
    // `[c] continue without checkpoints` was chosen: later state.json failures stay notices, the run is already degraded;
    // a failure of the FINAL write (finish() in flight) has no loop top left to pause at — it makes the run exit 3 instead
    if (disk.file === CHECKPOINT_FILES.state && this.blocked === null && !this.checkpointDegraded && !this.finishing) {
      this.installBlock({ step: step ?? this.step, kind: 'checkpoint-degraded', detail: checkpointDegradedDetail(disk.code, disk.file), stop: 'error', exitCode: 3 }, e);
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

  private emit(e: EngineEvent): void {
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
      consecutiveStageFailures: this.consecutiveStageFailures,
      jevQuestions: this.jevQuestions,
      ...(this.synthState !== null ? { synthState: this.synthState } : {}),
      // contract 1.1 (TUI-DESIGN §15 item 9): conditional spread, so an empty queue reads as absent (older readers unchanged)
      ...(this.pendingDirectives.length > 0 ? { pendingDirectives: this.pendingDirectives.map((d) => ({ ...d })) } : {}),
      ...(this.undoLog.length > 0 ? { undoLog: this.undoLog.map((u) => ({ ...u, restored: [...u.restored], skipped: u.skipped.map((k) => ({ ...k })) })) } : {}),
      ...(this.checkpointDegraded ? { checkpointDegraded: true } : {}),
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
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, confirmMs: 0, imagesMs: null },
      synthMs: null,
      synthJevMs: 0,
      generatorBatch: { inFlight: 0, startedAt: 0 },
      proposer: null,
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
    const retry = this.retryHooks('jev', draft.step, stage);
    try {
      res = await this.opts.decider.ask(state, questions, { signal: this.signal, stage, step: draft.step, onRetry: retry.onRetry, wake: retry.wake });
      retry.settled(true);
    } catch (e) {
      retry.settled(false);
      trace(`engine.ask ${stage} rejected ${e instanceof Error ? e.name : typeof e}`);
      throw e;
    }
    trace(`engine.ask ${stage} resolved attempts=${res.attempts}`);
    // TUI-DESIGN §13.2: a reachable Jev restarts the unreachable backoff (30 s again on the next pause)
    this.unreachablePauses = 0;
    this.opts.meter.add('jev', res.usage);
    this.noteUsage('jev', res.model, draft.step, stage, res.usage);
    // TUI-DESIGN §9.5: noteUsage read the raw (possibly NaN) cost; the record, the step draft and the sum take the clamped copy
    const usage = pricedUsage(res.usage);
    addUsage(draft.usage.jev, usage);
    draft.timing.jevMs += res.latencyMs;
    const ids = Object.keys(questions);
    const record: JevRequestRecord = { step: draft.step, stage, requestHash: res.requestHash, latencyMs: res.latencyMs, questions: ids.length, usage, model: res.model, attempts: res.attempts };
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
   * TUI-DESIGN §13.2 / §15 item 5: the `onRetry` / `wake` pair handed to one decider or provider call. `onRetry` creates a
   * fresh waker before every sleep (an AbortController aborts once) and emits `retry`; `wake` is the getter the clients
   * read per attempt; `settled` (call it in the finally of the call) emits `retry:settled` when a retry happened and
   * nulls the waker so a later retryNow() reports false.
   */
  private retryHooks(side: 'jev' | 'generator', step: number, stage: StageName, sample?: number): { onRetry: (info: RetryInfo) => void; wake: () => AbortSignal | undefined; settled: (ok: boolean) => void } {
    let retries = 0;
    let totalWaitMs = 0;
    // docs/LLM-JEV-DESIGN.md §4.8: wakers are keyed per sample; the status line (`retrying`) shows sample 0's — or the one-sample call's
    const shown = sample === undefined || sample === 0;
    const key = sample ?? 0;
    const setWaker = (w: AbortController | null): void => {
      if (shown) this.retryWaker = w;
      else if (w === null) this.sampleWakers.delete(key);
      else this.sampleWakers.set(key, w);
    };
    return {
      onRetry: (info) => {
        retries += 1;
        totalWaitMs += Math.max(0, info.waitMs);
        setWaker(new AbortController());
        if (shown) this.retrying = { side, attempt: info.attempt, maxAttempts: info.maxAttempts, untilMs: Date.now() + Math.max(0, info.waitMs) };
        this.emit({ type: 'retry', side, step, stage, info });
        this.emitStatus();
      },
      wake: () => (shown ? this.retryWaker : this.sampleWakers.get(key))?.signal,
      settled: (ok) => {
        setWaker(null);
        if (shown) this.retrying = null;
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
  private noteUsage(side: SpendSource, model: string, step: number, stage: StageName, usage: TokenUsage): void {
    if (!Number.isFinite(usage.costUsd)) {
      // TUI-DESIGN §9.5 (A135–A137): unknown pricing fails closed — the step commits, then the run stops with error unless
      // --allow-unpriced; the item is announced once per (side, model) per run, not once per metered call
      const key = `${side}:${model}`;
      if (!this.unpricedAnnounced.has(key)) {
        this.unpricedAnnounced.add(key);
        this.emit({ type: 'budget:unpriced', side, model, step, tokens: { input: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0, output: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0 } });
      }
      if (this.opts.allowUnpriced !== true && this.unpriced === null) this.unpriced = { side, model, stage };
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
      // index; absent in jev-only, where the propose stage never reaches the LLM (generate() throws there in any case)
      ...(this.mode === 'jev-only' ? {} : { generate: (req: GenerateRequest, o: SampleOptions) => self.generate(draft, req, 1, o) }),
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
   * The one metered, recorded path to the generating LLM. Without `sample` it is the propose stage's call (jev-on, jev-off:
   * one attempt, the engine's signal). With `sample` (llm-jev, docs/LLM-JEV-DESIGN.md §4.8) it is one sample of the
   * synthesizer's round: the sample's signal is linked to the engine's, every event and the generator.jsonl row carry the
   * sample index, a sample aborted (or failed after streaming) before its result is metered from an estimate
   * (`recordUnfinishedSample`) and rejects with the signal's reason, a sample already cancelled when it arrives is never
   * dispatched (no event, no row, no metering), and `timing.generatorMs` takes the wall of the round, not the sum of the samples.
   */
  private async generate(draft: StepDraft, req: GenerateRequest, attempt: number, sample?: SampleOptions): Promise<GenerateResult> {
    // Defence in depth for docs/JEV-ONLY.md: even with a real provider in the slot, jev-only never reaches it.
    if (this.mode === 'jev-only') throw new ConfigError('jev-only mode: the generating LLM must not be called', { setting: 'mode' });
    // §4.8: a sample cancelled before it reached the channel (a loser cancellation racing a stagger fire, or the engine
    // stopping) was never served — reject with the reason before any event, row or metered token
    if (sample !== undefined && sample.signal.aborted) throw sample.signal.reason;
    if (sample !== undefined && this.signal.aborted) throw this.signal.reason;
    const at = sample === undefined ? {} : { sample: sample.sample };
    this.emit({ type: 'generator:start', step: draft.step, attempt, ...at });
    // Tool-call argument fragments are reported as a cumulative character count per call; the
    // renderer coalesces ("streaming action… N chars", §7/§10). The text itself is parsed once at the end.
    let toolChars = 0;
    let textChars = 0;
    const retry = this.retryHooks('generator', draft.step, 'propose', sample?.sample);
    const link = sample === undefined ? null : this.linkSample(sample);
    const t0 = this.clock();
    if (sample !== undefined) this.noteSampleStart(draft);
    let res: GenerateResult;
    try {
      res = await this.opts.provider.generate(req, {
        signal: link?.signal ?? this.signal,
        ...at,
        onDelta: (text) => {
          textChars += text.length;
          this.emit({ type: 'generator:delta', step: draft.step, text, ...at });
        },
        onToolDelta: (fragment) => {
          toolChars += fragment.length;
          this.emit({ type: 'generator:tool-delta', step: draft.step, chars: toolChars, ...at });
        },
        onRetry: retry.onRetry,
        wake: retry.wake,
      });
      retry.settled(true);
    } catch (e) {
      retry.settled(false);
      if (sample !== undefined && link !== null) {
        const streamedChars = toolChars + textChars;
        const latencyMs = Math.max(0, this.clock() - t0);
        // §4.8: an aborted sample (deadline, loser cancellation, or the engine's own abort) yields no result but was served — meter the estimate
        if (link.signal.aborted) this.recordUnfinishedSample(draft, req, attempt, sample, { latencyMs, streamedChars, stopReason: abortStopReason(sample.signal.aborted ? sample.signal.reason : this.signal.reason) });
        // §2 principle 8: a sample the provider failed after it had streamed (stream cut, 5xx once the retries ran out) was served too
        else if (streamedChars > 0) this.recordUnfinishedSample(draft, req, attempt, sample, { latencyMs, streamedChars, stopReason: 'error' });
      }
      throw e;
    } finally {
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
    // the one-sample call adds the provider's latency; a round's samples close their batch wall in noteSampleEnd
    if (sample === undefined) draft.timing.generatorMs += res.latencyMs;
    draft.generatorRecords.push({
      step: draft.step,
      attempt,
      promptHash: sha12(toJson({ system: req.system, messages: req.messages })),
      model: res.model,
      // the request's own values (the propose stage sends opts.generation; a sample may differ per §4.6)
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      usage,
      latencyMs: res.latencyMs,
      stopReason: res.stopReason,
      malformed: false,
      ...(sample !== undefined ? { sample: sample.sample, purpose: sample.purpose } : {}),
      ...(res.usage.reasoningTokens !== undefined ? { reasoningTokens: res.usage.reasoningTokens } : {}),
      ...(res.generationId !== undefined ? { generationId: res.generationId } : {}),
    });
    this.emit({ type: 'generator:end', step: draft.step, usage, latencyMs: res.latencyMs, finishReason: res.stopReason, ...at });
    return res;
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

  /** docs/LLM-JEV-DESIGN.md §4.8: `generatorMs` of an llm-jev step is the wall of the round (the union of the samples' intervals), never the sum. */
  private noteSampleStart(draft: StepDraft): void {
    const b = draft.generatorBatch;
    if (b.inFlight === 0) b.startedAt = this.clock();
    b.inFlight += 1;
  }

  private noteSampleEnd(draft: StepDraft): void {
    const b = draft.generatorBatch;
    b.inFlight = Math.max(0, b.inFlight - 1);
    if (b.inFlight === 0) draft.timing.generatorMs += Math.max(0, this.clock() - b.startedAt);
  }

  /**
   * docs/LLM-JEV-DESIGN.md §4.8 / §2 principle 8: a sample aborted by its deadline or a loser cancellation — or failed by the
   * provider after it had streamed — yields no GenerateResult, but it was served. Input tokens = a finished sibling's prompt
   * tokens (same prompt hash: the round shares one prefix; any other finished row — an L2 reproduction request, an earlier
   * round — is a different prompt and says nothing), else the prompt's chars / 4; output tokens = streamed chars / 4; cost per
   * `estimateCostUsd`. The usage is marked `estimated`, metered so the spend cap and the token cap see it, and written as a
   * generator.jsonl row with `cancelled: true` and `stopReason` 'timeout' | 'cancelled' | 'error'. `GET /api/v1/generation?id=`
   * can replace the estimate post hoc once stage 2 surfaces the generation id on the abort (TODO src/provider/openrouter.ts).
   */
  private recordUnfinishedSample(draft: StepDraft, req: GenerateRequest, attempt: number, sample: SampleOptions, o: { latencyMs: number; streamedChars: number; stopReason: 'timeout' | 'cancelled' | 'error' }): void {
    const promptHash = sha12(toJson({ system: req.system, messages: req.messages }));
    const sibling = draft.generatorRecords.find((r) => r.cancelled !== true && r.promptHash === promptHash);
    const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = sibling !== undefined ? sibling.usage.inputTokens : Math.ceil(promptChars / 4);
    const outputTokens = Math.ceil(o.streamedChars / 4);
    const raw: TokenUsage = { inputTokens, outputTokens, costUsd: this.estimateCostUsd(sibling, inputTokens, outputTokens), calls: 1, estimated: true };
    this.opts.meter.add('generator', raw);
    this.generatorTokens += inputTokens + outputTokens;
    this.noteUsage('generator', this.opts.provider.model, draft.step, 'propose', raw);
    // TUI-DESIGN §9.5: noteUsage read the raw (possibly NaN = unpriced) cost; the record, the event and the step sum take the clamped copy
    const usage = pricedUsage(raw);
    addUsage(draft.usage.generator, usage);
    draft.generatorRecords.push({
      step: draft.step,
      attempt,
      promptHash,
      model: this.opts.provider.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      usage,
      latencyMs: o.latencyMs,
      stopReason: o.stopReason,
      malformed: false,
      sample: sample.sample,
      purpose: sample.purpose,
      cancelled: true,
    });
    this.emit({ type: 'generator:end', step: draft.step, usage, latencyMs: o.latencyMs, finishReason: o.stopReason, sample: sample.sample });
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

  private async runStep(): Promise<{ stop: StopReason | null; detail?: string }> {
    const step = this.step + 1;
    const draft = this.newDraft(step);
    this.draft = draft;
    this.stageBlock = null;
    this.emit({ type: 'step:start', step, startedAt: draft.startedAt });
    // llm-jev (docs/LLM-JEV-DESIGN.md §3): replan on a trip, otherwise straight to the synth propose stage — no intent or context request
    let stage: StageName = usesJev(this.mode) ? (this.detector.tripped() ? 'replan' : this.mode === 'llm-jev' ? 'propose' : 'intent') : 'propose';
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
        if (llmJev) {
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
        if (this.mode === 'jev-only' || llmJev) {
          // The Synthesizer proposes (docs/JEV-ONLY.md): in jev-only no generator call, no generator:* events, no generator.jsonl
          // row; in llm-jev the synthesizer spends generator samples through SynthesisContext.generate (docs/LLM-JEV-DESIGN.md §4.8).
          const synthesizer = this.synthesizer;
          if (synthesizer === null) throw new ConfigError(`${this.mode} mode requires a synthesizer`, { setting: 'mode' });
          // TODO(stage 4, docs/LLM-JEV-DESIGN.md §9.4): when `synthesizer.handles(wsInfo, files)` is false, run runProposeStage
          // here with draft.proposer = 'generic' — the flag (not the mode) keys `generator_done` and the verbatim claim evidence
          if (llmJev) draft.proposer = 'synth';
          const sctx = this.synthesisContext(draft, contextFiles);
          const s0 = this.clock();
          const jev0 = draft.timing.jevMs;
          try {
            p = await this.stage('propose', () => runSynthStage(ctx, synthesizer, sctx));
          } finally {
            // docs/LLM-JEV-DESIGN.md §7.5: the synth wall and the Jev latency spent inside it (the shell's share is the rest)
            draft.synthMs = Math.max(0, this.clock() - s0);
            draft.synthJevMs = Math.max(0, draft.timing.jevMs - jev0);
          }
          // llm-jev: the round's per-sample rows (cancelled estimates included) reach generator.jsonl exactly as after runProposeStage; a no-op in jev-only
          this.flushGeneratorRecords(draft);
        } else {
          const prompt = this.promptInput(draft, changedFiles, contextFiles, null);
          p = await this.stage('propose', () => runProposeStage(ctx, this.systemPrompt, prompt));
          this.flushGeneratorRecords(draft);
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
        draft.matchesIntent = rk.matchesIntent;
        draft.patchTargets = rk.targets;
        if (rk.risk.verdict === 'block') {
          draft.outcome = { status: 'blocked', reason: rk.risk.reason };
          this.counters.blocked += 1;
          this.emit({ type: 'outcome', step, outcome: draft.outcome });
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
        if (this.blocked !== null) {
          // TUI-DESIGN §13.3: that checkpoint failed on a disk class (or a pause was requested by a write): nothing executes until the pane is answered
          this.interrupted = { step, stage: 'execute', proposal: draft.proposal };
          this.emit({ type: 'transcript', step, level: 'warn', text: `${this.blocked.kind} before execute; step ${step} discarded` });
          this.absorbDiscardedTiming(draft);
          return { stop: null };
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
        const pre = imageSource !== null ? await this.takePreImages(draft, imageSource, changedFiles) : null;
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
        if (imageSource !== null) await this.takePostImages(draft, imageSource, ex.changedFiles, pre);
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
    const committed = this.commit(draft);
    if (committed.stop) return { stop: committed.stop };
    if (stopAfterCommit) return { stop: stopAfterCommit };
    if (this.unpriced !== null) {
      // TUI-DESIGN §9.5: usage.cost null/non-finite → the step committed, the run stops with error unless --allow-unpriced (exit 2, the flag is named)
      const u = this.unpriced;
      this.fatalError = new ConfigError(`${u.side} usage.cost missing for ${u.model}: the $${this.opts.limits.spendCapUsd.toFixed(3)} spend cap cannot be enforced; pass --allow-unpriced to run under a token cap instead`, { setting: u.side === 'jev' ? 'decider.model' : 'generator.model' });
      this.stateError = { stage: u.stage, code: 'config' };
      return { stop: 'error', detail: 'unpriced_usage' };
    }
    if (this.completeAfter(draft)) return { stop: 'complete' };
    // docs/LLM-JEV-DESIGN.md §9.4: the generic fallback's `done` (draft.proposer 'generic', stage 4) stops as the generator's, like jev-off
    if ((this.mode === 'jev-off' || draft.proposer === 'generic') && draft.outcome?.status === 'noop') return { stop: 'generator_done' };
    if (this.consecutiveStageFailures >= CONSECUTIVE_STAGE_FAILURE_LIMIT) {
      const err = draft.error ?? { stage, code: 'internal' };
      this.stateError = { stage: err.stage, code: err.code };
      return { stop: 'error' };
    }
    return { stop: null };
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
    try {
      const r = await writePreImages(this.runDir, draft.step, targets, { root: this.workspace.root, source, now: () => this.clock() });
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + r.ms;
      return r;
    } catch (e) {
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + Math.max(0, this.clock() - t0);
      this.noteImagesFailure(draft, 'pre', e);
      return null;
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
    } catch (e) {
      draft.timing.imagesMs = (draft.timing.imagesMs ?? 0) + Math.max(0, this.clock() - t0);
      this.noteImagesFailure(draft, 'post', e);
    }
  }

  /** An image write that failed never fails the step: a warning line, and the disk-class notice when it is one (§13.3). */
  private noteImagesFailure(draft: StepDraft, which: 'pre' | 'post', e: unknown): void {
    this.emit({ type: 'transcript', step: draft.step, level: 'warn', text: `${which}-images write failed: ${e instanceof Error ? this.redact(e.message) : String(e)}` });
    this.noteDiskError(e, which === 'pre' ? CHECKPOINT_FILES.pre : CHECKPOINT_FILES.post, draft.step);
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
    if (this.mode === 'llm-jev') {
      const t = this.llmJevTiming(draft, total);
      this.timing.harnessMs += t.harnessMs;
      this.timing.synthMs = (this.timing.synthMs ?? 0) + (t.synthMs ?? 0);
    } else {
      this.timing.harnessMs += Math.max(0, total - draft.timing.generatorMs - draft.timing.jevMs - draft.timing.execMs - draft.timing.confirmMs);
    }
  }

  /**
   * docs/LLM-JEV-DESIGN.md §7.5 (llm-jev): `synthMs` = wall of synthesize(); `harnessMs` = total − synthMs − execMs − confirmMs −
   * the shell's Jev latency (requests outside the synthesizer). The generator batch wall and the synthesizer's Jev requests sit
   * inside synthMs and are reported in their own buckets without being subtracted again.
   */
  private llmJevTiming(draft: StepDraft, total: number): StepTiming {
    const synthMs = draft.synthMs ?? 0;
    const shellJevMs = Math.max(0, draft.timing.jevMs - draft.synthJevMs);
    return {
      generatorMs: draft.timing.generatorMs,
      jevMs: draft.timing.jevMs,
      execMs: draft.timing.execMs,
      harnessMs: Math.max(0, total - synthMs - draft.timing.execMs - draft.timing.confirmMs - shellJevMs),
      totalMs: total,
      synthMs,
      ...(draft.timing.imagesMs !== null ? { imagesMs: draft.timing.imagesMs } : {}),
    };
  }

  /** The stop rule after a step: llm-jev → the code fact of docs/LLM-JEV-DESIGN.md §6.6; jev-on / jev-only → `task_complete >= completeThreshold`. */
  private completeAfter(draft: StepDraft): boolean {
    if (this.mode === 'llm-jev') return isCompleteByFact(this.completionFact(draft));
    return usesJev(this.mode) && isComplete(draft.completion, this.opts.limits.completeThreshold);
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
      // the recorded `tests_pass_unparsed` stands in only when the parser read nothing (judge.ts codeJudge)
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
      // TUI-DESIGN §8.6: one hints line per directive for exactly this step; §15 item 11: the @-mentioned files
      humanDirectives: this.activeHuman?.step === draft.step ? [...this.activeHuman.texts] : [],
      pinnedFiles: [...(this.opts.seed?.pinnedFiles ?? [])],
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
      // jev-off, and the llm-jev generic fallback (docs/LLM-JEV-DESIGN.md §9.4: keyed on draft.proposer, not the mode): claims verbatim
      if (this.mode === 'jev-off' || draft.proposer === 'generic') return status === 'executed' || status === 'noop' ? { kind: 'verbatim' } : { kind: 'none', because: `outcome ${status ?? 'none'}` };
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
    if (draft.tests?.parsed) {
      this.lastTestRun = { step, command: draft.tests.command, passed: draft.tests.parsed.passed, failed: draft.tests.parsed.failed, errors: draft.tests.parsed.errors, allPassed: draft.tests.allPassed === true };
      // the run's output tail for the `done` state's `lastRun.output` (loop/synth team request; state.ts ExecutedInfo.lastRunOutput)
      this.lastTestRunOutput = draft.output;
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
            harnessMs: Math.max(0, total - draft.timing.generatorMs - draft.timing.jevMs - draft.timing.execMs - draft.timing.confirmMs),
            totalMs: total,
            // TUI-DESIGN §12.3 / §15 item 3: image time is already inside harnessMs and is reported separately for perf/step-overhead.ts
            ...(draft.timing.imagesMs !== null ? { imagesMs: draft.timing.imagesMs } : {}),
          };
    this.timing.generatorMs += timing.generatorMs;
    this.timing.jevMs += timing.jevMs;
    this.timing.execMs += timing.execMs;
    this.timing.harnessMs += timing.harnessMs;
    this.timing.totalMs += timing.totalMs;
    if (timing.imagesMs !== undefined) this.timing.imagesMs = (this.timing.imagesMs ?? 0) + timing.imagesMs;
    if (timing.synthMs !== undefined) this.timing.synthMs = (this.timing.synthMs ?? 0) + timing.synthMs;
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
    const signatures = computeSignatures({
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
      usage: draft.usage,
      timing,
      loopSignatures: signatures,
    };
    if (draft.proposer !== null) record.proposer = draft.proposer;
    if (draft.interruptedAt) record.interruptedAt = draft.interruptedAt;
    if (draft.error) record.error = draft.error;
    if (this.completeAfter(draft)) record.stoppedAt = 'complete';
    else if (checkBudgets(this.budgetInput()) !== null) record.stoppedAt = 'step_start';
    // TUI-DESIGN §8.7 / §15 item 3: the committed plan after this step, bounded, so /rewind N seeds without replaying drafts
    record.planAfter = planSnapshot(plan);

    const snapshot = this.buildCheckpointState();
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
    const snapshot = this.buildCheckpointState();
    const result = assembleRunResult({ runId: this.runId, mode: this.mode, reason, state: snapshot, error });
    const stopLine: EngineEvent = { type: 'transcript', step: null, level: reason === 'complete' ? 'info' : 'warn', text: stopTranscriptLine(reason, this.step, opts.detail) };
    let stateWritten = opts.skipWrite === true; // a refused resume leaves the stored state.json as it was
    // TUI-DESIGN §13.5 / §15 item 14: exit code, resumability and the artefact paths ride run:end; built when the final write has settled.
    // Pre-redacted so the line written before flush is the very event the renderers receive last.
    const buildEnd = (): EngineEvent => {
      const resumable = stateWritten && !this.checkpointDegraded && reason !== 'complete' && reason !== 'generator_done';
      const paths = { runDir: this.runDir, transcript: join(this.runDir, CHECKPOINT_FILES.transcript), log: join(this.runDir, CHECKPOINT_FILES.log) };
      return redactDeep({ type: 'run:end', result, exitCode: this.exitCodeOf(reason, error), resumable, paths } satisfies EngineEvent, this.redact) as EngineEvent;
    };
    let endEvent: EngineEvent | null = null;
    let stopEmitted = false;
    if (!opts.skipWrite) {
      const phase = (async (): Promise<void> => {
        // Stray background process groups from a successful run must not outlive it (§8); abort() already killed on its path.
        if (!this.aborting) await this.sandbox.killAll().catch(() => undefined);
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
        // The stop line and the run:end line reach transcript.log through the same item model as every other line (§10).
        stopEmitted = true;
        this.emit(stopLine);
        endEvent = buildEnd();
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
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.lastResult = result;
    if (!stopEmitted) this.emit(stopLine);
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

export async function createEngine(opts: EngineOptions, deps: EngineDeps = {}): Promise<Engine> {
  // jev-only and llm-jev (docs/LLM-JEV-DESIGN.md §3) put the Synthesizer in the propose stage
  if ((opts.mode === 'jev-only' || opts.mode === 'llm-jev') && !opts.synthesizer) throw new ConfigError(`${opts.mode} mode requires a synthesizer (EngineOptions.synthesizer)`, { setting: 'mode' });
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
  if (opts.resume) {
    runId = opts.resume.runId;
    await validateResumeId(opts.runsDir, runId);
    store = d.createCheckpointStore(opts.runsDir, runId, redact);
    resume = await d.loadForResume(opts.runsDir, runId, redact, store);
    if (resume.store) store = resume.store;
    if (resume.state.runId !== runId) throw new CheckpointError(`state.json belongs to run ${resume.state.runId}, not ${runId}`, store.dir);
    if (resume.state.mode !== opts.mode) throw new ConfigError(`--resume: run ${runId} was a ${resume.state.mode} run`, { setting: 'mode' });
    if ((resume.previousStopReason ?? resume.state.stopReason) === 'complete' && !opts.resume.force) throw new ConfigError(`--resume: run ${runId} is complete; pass --force to continue it`, { setting: 'resume' });
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
  try {
    git = await d.probeGitState(root);
  } catch {
    git = null;
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
  return new EngineImpl({ runId, opts, store, workspace, sandbox, wsInfo, resume, gitState: git, runDir, lock: lock ?? { held: false, warning: null }, headDrift });
}

/** Effective intent helper exported for tests and the TUI: the safe default of Choice resolution. */
export const DEFAULT_INTENT: Intent = 'investigate';
