/**
 * Bench-local types (DESIGN.md §13). The shared contract owns BenchTaskRecord, BenchDeps and
 * the mock scripting surface; everything here is the runner's own vocabulary: options, the
 * task abstraction both suites implement, evaluations and the aggregate shapes written to
 * summary.json.
 */
import type {
  ActionOutcome,
  BenchEvaluator,
  BenchStopReason,
  BenchSuite,
  BenchTaskRecord,
  ConfigRecordValue,
  EngineMode,
  ExecResult,
  MockTurn,
  RunLimits,
  RunResult,
  SandboxProfile,
} from '../core/types.js';

export type BenchSuiteSelector = BenchSuite | 'all';

export interface BenchOptions {
  suite: BenchSuiteSelector;
  /** --tasks <n>: first n tasks of each selected suite (dataset order) */
  tasks?: number | null;
  /** --task-id a,b: explicit ids; wins over `tasks` */
  taskIds?: string[] | null;
  conditions: EngineMode[];
  concurrency: number;
  live: boolean;
  /** bench total, shared by every run through one root SpendMeter */
  spendCapUsd: number;
  /** per run (root.child) */
  taskSpendCapUsd: number;
  allowModelAlias: boolean;
  resumeBenchId?: string | null;
  /** results dir; default bench/results/<benchId> under cwd */
  outDir?: string | null;
  runsDir: string;
  /** bench/data root; default <cwd>/bench/data */
  dataDir?: string;
  limits: RunLimits;
  sandboxProfile: SandboxProfile;
  noNetwork: boolean;
  generation: { temperature: number | null; maxTokens: number };
  deciderModel: { configured: string; pinned: boolean };
  configRecord: Record<string, ConfigRecordValue>;
  redact: (s: string) => string;
  secretPaths: readonly string[];
  /** injectable clock */
  now?: () => Date;
  /** progress lines (default: none) */
  log?: (line: string) => void;
  /** external abort (Ctrl-C on the bench command) */
  signal?: AbortSignal;
  /** setup (clone + venv) timeout, default 20 min */
  setupTimeoutMs?: number;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}
/** A sandboxed `sh -c` bound to one workspace root (built from BenchDeps.createSandbox). */
export type CommandRunner = (command: string, opts?: CommandRunOptions) => Promise<ExecResult>;

export interface BenchSetupTools {
  /** cwd = the agent workspace; the sandbox is rooted at the pair dir (workspace + aux) plus the sandbox run dir */
  run: CommandRunner;
  /** a runner for another root (bare-clone cache, venv dir); asking for the workspace path yields `run` */
  makeRunner: (workspaceRoot: string) => CommandRunner;
  mocked: boolean;
  runsDir: string;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface PatchExtraction {
  modelPatch: string;
  patchBytes: number;
  patchEmpty: boolean;
}

export interface BenchEvaluateContext {
  workspaceDir: string;
  /** <runsDir>/<runId> */
  runDir: string;
  runsDir: string;
  /** cwd = workspace; sandbox rooted at the pair dir with the engine's run dir (model_patch.diff, eval/) as second root */
  run: CommandRunner;
  makeRunner: (workspaceRoot: string) => CommandRunner;
  mocked: boolean;
  condition: EngineMode;
  result: RunResult;
  /** every `outcome` event of the run, in order */
  outcomes: ActionOutcome[];
  /** set when the task exported extractPatch() */
  patch: PatchExtraction | null;
  signal: AbortSignal;
  log: (line: string) => void;
}

export type TestsStatus = NonNullable<BenchTaskRecord['testsStatus']>;

export interface Evaluation {
  pass: boolean | null;
  evaluator: BenchEvaluator;
  reason?: string;
  patchApplied?: boolean | null;
  testsStatus?: TestsStatus;
  evalExitCode?: number | null;
}

export interface BenchTaskMeta {
  difficulty?: string;
  category?: string;
  instructionShim?: boolean;
  baseCommit?: string;
}

/** One benchmark task bound to a concrete workspace path. `task` is the ONLY text the engine sees. */
export interface BenchTask {
  suite: BenchSuite;
  id: string;
  task: string;
  setup(workspaceDir: string, tools: BenchSetupTools): Promise<void>;
  /** SWE-bench: model_patch extraction after the engine stopped, for every stopReason */
  extractPatch?(ctx: BenchEvaluateContext): Promise<PatchExtraction>;
  evaluate(ctx: BenchEvaluateContext): Promise<Evaluation>;
  mockTrajectory(): MockTurn[];
  meta: BenchTaskMeta;
}

export interface BuildTaskOptions {
  /** absolute agent workspace path for this (task, condition) */
  workspaceDir: string;
  /** runner-owned sibling dir for staged data outside the workspace (Terminal-Bench /root/data) */
  auxDir: string;
  mocked: boolean;
}

/** A task known to the runner before any workspace exists; `build` binds it to a pair's paths. */
export interface BenchTaskSource {
  suite: BenchSuite;
  id: string;
  meta: BenchTaskMeta;
  build(opts: BuildTaskOptions): BenchTask;
}

export interface ConditionConfig {
  mode: EngineMode;
  generatorModel: string;
  deciderModel: string | null;
  temperature: number | null;
  maxTokens: number;
  maxSteps: number;
  maxWallMs: number;
  maxReplans: number;
  taskSpendCapUsd: number;
  sandboxProfile: SandboxProfile;
  noNetwork: boolean;
  commandTimeoutMs: number;
  maxCommandTimeoutMs: number;
  maxOutputBytes: number;
  completeThreshold: number;
  impossibleThreshold: number;
}

export interface Stat {
  n: number;
  mean: number | null;
  median: number | null;
}
export interface SolvePoint {
  k: number;
  solved: number;
  fraction: number | null;
}
export interface TokensPoint {
  step: number;
  mean: number;
  n: number;
}

export interface ConditionMetrics {
  condition: EngineMode;
  tasks: number;
  evaluated: number;
  passed: number;
  passRate: number | null;
  /** "passed/evaluated (n)" */
  passRateText: string;
  unevaluated: string[];
  unsupported: string[];
  notRun: string[];
  stepsToSolve: Stat & { values: number[] };
  solveCurve: SolvePoint[];
  stepsUsed: Stat;
  stopReasons: Record<string, number>;
  tokensPerStepCurve: TokensPoint[];
  meanTokensPerStep: { mean: number | null; steps: number };
  jevLatencyMs: { p50: number | null; p95: number | null; n: number };
  jevRequests: number;
  jevQuestions: number;
  blocked: number;
  reviews: number;
  declined: number;
  loops: number;
  replans: number;
  reads: { total: number; meanPerRun: number | null };
  cost: { generator: number; jev: number; total: number };
  wallMs: Stat;
  modelDrift: string[];
  runsWithError: string[];
}

export interface PairedRow {
  task: string;
  pass: Record<string, boolean | null>;
  steps: Record<string, number>;
  reads: Record<string, number>;
  cost: Record<string, number>;
}

export interface SuiteComparison {
  suite: BenchSuite;
  conditions: EngineMode[];
  /** tasks evaluated in every condition, modelDrift excluded */
  pairedTasks: string[];
  incompletePairs: string[];
  excludedForDrift: string[];
  perCondition: Record<string, ConditionMetrics>;
  rows: PairedRow[];
}

export interface SuiteMetrics {
  suite: BenchSuite;
  perCondition: Record<string, ConditionMetrics>;
  comparison: SuiteComparison;
}

export interface Summary {
  benchId: string;
  createdAt: string;
  finishedAt: string;
  mocked: boolean;
  suites: BenchSuite[];
  conditions: Record<string, ConditionConfig>;
  conditionOrder: EngineMode[];
  generatorModel: string;
  spendCapUsd: number;
  taskSpendCapUsd: number;
  spentUsd: { generator: number; jev: number; total: number };
  capFired: 'bench' | null;
  notRun: { count: number; tasks: string[] };
  pairedTasks: Record<string, number>;
  records: number;
  perSuite: Record<string, SuiteMetrics>;
  resumed: boolean;
}

export interface BenchRunOutput {
  benchId: string;
  outDir: string;
  records: BenchTaskRecord[];
  summary: Summary;
  comparisonMarkdown: string;
}

export type { BenchStopReason };
