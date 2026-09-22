/**
 * Bench-local types (DESIGN.md §13). The shared contract owns BenchTaskRecord, BenchDeps and
 * the mock scripting surface; everything here is the runner's own vocabulary: options, the
 * task abstraction both suites implement, evaluations and the aggregate shapes written to
 * summary.json.
 */
import type {
  ActionOutcome,
  BenchCondition,
  BenchDeps,
  BenchEvaluator,
  BenchStopReason,
  BenchSuite,
  BenchTaskRecord,
  ConfigRecordValue,
  Decider,
  EngineMode,
  ExecResult,
  GenerateReasoning,
  MockTurn,
  RunLimits,
  RunResult,
  SandboxProfile,
  Synthesizer,
  SynthesizerArmMode,
  SynthesizerGeneration,
} from '../core/types.js';

export type BenchSuiteSelector = BenchSuite | 'all';

export type { SynthesizerArmMode } from '../core/types.js';

/** What the runner hands the synthesizer factory (src/synth/index.ts `SynthesizerOptions`, the arm's `mode` and pinned `generation` required). */
export interface CreateSynthesizerOptions {
  decider: Decider;
  redact: (s: string) => string;
  /** docs/LLM-JEV-DESIGN.md §10.1: the arm; the synthesizer must echo it (`Synthesizer.mode`) or the runner refuses the arm */
  mode: SynthesizerArmMode;
  /** the llm-jev / llm-sieve arms' pinned generation (`PinnedGeneration.synthesizer`); the synthesizer must echo it too */
  generation?: SynthesizerGeneration;
}

/**
 * BenchDeps plus the synthesizer factory (the shared BenchDeps in core/types.ts is frozen). Required when the
 * conditions include a synthesizer arm (jev-only, llm-jev, llm-sieve); bench/cli.ts passes src/synth.
 */
export type BenchDepsWithSynth = BenchDeps & {
  createSynthesizer?: (opts: CreateSynthesizerOptions) => Synthesizer;
};

/** docs/LLM-JEV-DESIGN.md §8: USD per million tokens the generator's served provider bills (GLM flash: 5/3× the models-API table). */
export interface ServedRate {
  inputPerM: number;
  outputPerM: number;
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

/**
 * docs/LLM-JEV-DESIGN.md §10.4: what one run's generator.jsonl says, per call. `valid` = not malformed ∧ not cancelled ∧
 * `stopReason` not a length stop (the §1.2 definition). `estimatedUsd` is the share of `costUsd` booked from estimates
 * (cancelled / timed-out samples, §4.8). `validLatencyMs` is over valid calls only (the round p50 of §7 is this figure).
 */
export interface GeneratorCallsSummary {
  calls: number;
  /** rows with a sample index (the synthesizer's rounds) */
  samples: number;
  valid: number;
  /** rows marked malformed that were NOT dropped calls (a drop is booked once, under `cancelled` / `timeouts`) */
  malformed: number;
  lengthStops: number;
  /** rows written from an estimate: `cancelled: true` (stopReason timeout | cancelled | error) or a tuned-provider `timeout` stand-in */
  cancelled: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  estimatedUsd: number;
  latencyMs: LatencySummary;
  validLatencyMs: LatencySummary;
  /** every row's latency, so a per-condition aggregate takes exact quantiles */
  latencyRawMs: number[];
  validLatencyRawMs: number[];
}

/**
 * docs/LLM-JEV-DESIGN.md §10.4: what one run's steps.jsonl says about the synthesizer — the `synthMs` bucket (§7.5), the
 * `StepRecord.verify` counts summed over the steps, and the steps the generic fallback proposed (§9.4). Zeros for a run
 * written before those fields existed.
 */
export interface StepsSummary {
  steps: number;
  /** steps that carried `timing.synthMs` */
  synthSteps: number;
  synthMs: number;
  genericSteps: number;
  verify: {
    samples: number;
    distinct: number;
    malformed: number;
    timeouts: number;
    cancelled: number;
    misanchored: number;
    candidatesTested: number;
    passers: number;
    partials: number;
    graceMs: number;
    /** steps whose committed change lay outside every listing */
    localisationMissed: number;
  };
  /**
   * OOS iteration 3, item 3: the `JEVCODE_DEADLINE_GROWTH` arm the run's steps recorded — `always`
   * (today's behaviour, the default), `served`, or `mixed` when a merge spans both. Absent when no
   * step recorded one (jev-only, or a record written before the flag existed). Not a count: it is
   * the arm, so `mergeStepsSummaries` unions rather than sums it.
   */
  deadlineGrowth?: 'served' | 'always' | 'mixed';
  /**
   * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §5.5: `src/bench/step-records.ts` is the ONLY bridge from
   * `steps.jsonl` to `BenchRecord.synth`. Without these members every `fastPath` and `router` field the engine writes
   * into the run directory is invisible to every bench table — the rows of §8.3 would read zero for a reason that has
   * nothing to do with the fast path. Rows written by an engine that has no fast path contribute zeros, never an error
   * (the reader dereferences only what it sums).
   */
  fastPath: FastPathSummary;
  /** §8.3 R-a: the router seam. `maxWaitMs` must be 0 — a router that made the loop WAIT has gated it (§2.1). */
  routers: { issued: number; applied: number; dropped: number; maxWaitMs: number };
  /** §8.3 R-e: steps that took the code verdict on risk, and steps where Jev was unavailable at all. */
  risk: { codeVerdicts: number; jevUnavailable: number };
  /**
   * contract 1.9 (Fastlane) §3 / §5.2: the S2 members of `StepVerifySummary`. `ttfbMs` is kept raw so a quantile over a
   * merged run set is exact rather than an average of averages — the hedge threshold is `2 × running TTFB p50`, so a
   * p50 that was itself computed from p50s would be measuring the wrong thing.
   *
   * `cacheInput` is the same rule for the §3.3 prefix-pinning measurement, which is why the per-step
   * `StepVerifySummary.cacheHitRate` is NOT carried here: the run's hit rate is `cacheRead / cacheInput` over the
   * summed tokens, and the mean of the steps' own rates is a different number (10/1,000 with 90/100 is a true 9.1 %
   * and a mean-of-ratios 45.5 %). Recomputing beats folding a ratio, so the denominator travels and the rate does not.
   * (F26 in §9.1: `cacheInput` covers the rounds whose provider reported cache at all — a round that reported none
   * contributes neither numerator nor denominator, so the rate is over the reporting steps, not over the arm's input.)
   *
   * `state` is NOT a count and not a token figure: it is what the run said about the §3 mechanisms themselves
   * (`StepRecord.mechanisms.s2`, slot A's F25), unioned exactly as `deadlineGrowth` and `warm.mode` are — steps that
   * disagree fold to `'partial'`, because one S2 step must not stand for an arm that exists to be a one-mechanism
   * contrast. ABSENT means no step reported the member, which is a different fact from a measured `'off'`: only the
   * second may overwrite an arm's pinned `ArmMechanisms.s2` (F05, B4; `bench/next-arms.ts observedArmS2`).
   */
  s2: { ttfbMs: number[]; hedges: number; hedgeWins: number; cacheRead: number; cacheWrite: number; cacheInput: number; state?: S2State };
  /**
   * OOS iteration 2, defect 2 / defect 4: the S1 warm verification plane's counters, summed over
   * the run's steps (`StepRecord.verify.warm`, core/types.ts `StepWarmSummary`). Absent when no
   * step recorded one — which is every run with `JEVCODE_WARM` unset, the default — so a warm-off
   * record is unchanged. `mode` is the arm, not a count, so it is unioned rather than summed
   * exactly as `deadlineGrowth` is: `unsupported-runner` on its own is how a report counts the
   * tasks a warm A/B did not actually cover.
   */
  warm?: {
    mode: 'on' | 'unsupported-runner' | 'unsupported-command' | 'mixed';
    offered: number;
    screened: number;
    confirmed: number;
    mismatches: number;
    fallbacks: number;
    restarts: number;
    invalidations: number;
    scopeUnusable: number;
    deadlineRechecks: number;
    screenMs: number;
    confirmMs: number;
    /** steps whose plane reported a one-way `disabledReason` */
    disabled: number;
    /** the first reason seen; absent when the plane never turned itself off */
    disabledReason?: string;
  };
}

/** contract 1.9 (Fastlane) §5.5 / §8.3: one run's route-R9 facts, summed over its steps. */
export interface FastPathSummary {
  /** steps where the arm was armed and the predicate was evaluated */
  considered: number;
  fired: number;
  declined: number;
  failed: number;
  /** fired steps that produced a proposal / that the acceptance rule refused */
  proposed: number;
  refused: number;
  timeouts: number;
  /** §8.3 R-d: the per-reason decline histogram, exhaustive over `FastPathReason` (an 'error' bucket over 5 % is a fail) */
  reasons: Record<string, number>;
  /**
   * §8.3 R-c: steps where stage 1 HELD — i.e. rows the writer recorded at `stage: 2`, whatever stage 2 then decided
   * (fired, declined or failed). This is the denominator the writer can actually produce: it records `stage: 1`
   * only on a free decline and `stage: 2` on every row of a round that ran, so a "stage-1-FIRED" count is 0 on every
   * real run and the ratio below could never fail.
   */
  stage1Held: number;
  /** §8.3 R-c numerator: rows at `stage: 2` that stage 2 declined — above 0.3 of `stage1Held` the PREDICATE is wrong, not the budget */
  stage2Declined: number;
  candidatesTested: number;
  testRuns: number;
  jevRequests: number;
  wallMs: number;
  /**
   * §8.3 R-b: steps that RAN A ROUND (`stage: 2`) whose `wallMs` exceeded their own `budgetMs`; must be 0. Counting
   * only `decision: 'fired'` rows would miss the shape that matters most — a round that blew the budget and then
   * timed out or was refused is recorded `decision: 'failed'`.
   */
  budgetOverruns: number;
}

/**
 * tasks.jsonl record plus the bench-local fields (BenchTaskRecord is frozen): `generatorCalls` =
 * RunResult.usage.generator.calls (a jev-only record with any generator usage is written with `pass: null,
 * evaluator: 'invalid', reason: 'generator called in jev-only'`); `meta` is the source's BenchTaskMeta (kind / hunks /
 * difficulty) so comparison.md can break pass rates down per suite without re-reading bench/data; the rest are the
 * §10.4 per-run measurements the runner reads from the run directory after the engine stopped.
 */
export type BenchRecord = BenchTaskRecord & {
  generatorCalls?: number;
  meta?: BenchTaskMeta;
  /** per-call summary of `<runDir>/generator.jsonl`; absent when the run wrote none */
  generator?: GeneratorCallsSummary;
  /** per-step summary of `<runDir>/steps.jsonl` (synthMs, verify counts, generic steps); absent when the run wrote none */
  synth?: StepsSummary;
  /** the rate the estimates of this run were priced at */
  servedRate?: ServedRate;
  /** llm-sieve: Jev requests the stub answered (each is a request the arm did NOT make) */
  stubbedJevRequests?: number;
  /** jev-off-tuned: calls the per-call deadline dropped, and calls re-issued once at double max_tokens after a length stop */
  tuned?: { timeouts: number; doubled: number };
  /** os.loadavg() when the engine started (§10.1: the machine is meant to be otherwise idle) */
  loadavg?: [number, number, number];
};

export interface BenchOptions {
  suite: BenchSuiteSelector;
  /** --tasks <n>: first n tasks of each selected suite (dataset order) */
  tasks?: number | null;
  /** --task-id a,b: explicit ids; wins over `tasks` */
  taskIds?: string[] | null;
  conditions: BenchCondition[];
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
  /**
   * the user's generator settings, recorded for the report only: every arm runs its PINNED parameters
   * (bench/conditions.ts `pinnedGeneration`), never these (docs/LLM-JEV-DESIGN.md §9.1, §10.1)
   */
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
  /**
   * `--archive-runs`: after the results are written, copy every run's record files into
   * `<resultsDir>/runs/<runId>/<name>.gz` (bench/archive.ts). Off by default — the records of a
   * full bench are ~100 MB raw, and only an experiment that will be re-analysed needs them
   * checked in beside its results (docs/research/llm-jev/oos-analysis-2026-09-22.md).
   */
  archiveRuns?: boolean;
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
  condition: BenchCondition;
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
  /** QuixBugs bug kind (index.json `kind`) */
  kind?: string;
  /** Ladder: kinds of the fix and number of `diff -U0` hunks src → gold */
  kinds?: string[];
  hunks?: number;
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

export type LengthHandling = 'none' | 'double-once';

/**
 * docs/LLM-JEV-DESIGN.md §10.1: the generation parameters an arm is pinned to, recorded verbatim in summary.json. `jev-off`
 * is exactly the checked-in baseline runs (`{temperature: null, maxTokens: 4096}`, no `reasoning`, no deadline); the
 * others are the §4 hygiene as far as the arm's grammar allows.
 */
export interface PinnedGeneration {
  proposer: 'generator' | 'synthesizer';
  /** the request's temperature; null = not sent. The synthesizer arms set it per sample (`sampleTemperatures`). */
  temperature: number | null;
  /** §4.6: sample 0 / samples 1..N−1 of a synthesizer round; absent for the generator-only arms */
  sampleTemperatures?: readonly number[];
  /** base max_tokens of a call (doubled once after a `length` stop when `lengthHandling` says so) */
  maxTokens: number;
  /** null = the parameter is not sent (the model's default) */
  reasoning: GenerateReasoning | null;
  /** per-call (generator arms) / per-sample (synthesizer arms, the QuixBugs-ladder class ceiling) deadline; null = none */
  deadlineMs: number | null;
  /** §4.8: the repository-class sample deadline of the synthesizer arms */
  repositoryDeadlineMs?: number;
  lengthHandling: LengthHandling;
  servedRate: ServedRate;
  /**
   * the synthesizer arms: the ONE object handed to `createSynthesizer({generation})` and echoed back as `Synthesizer.generation`
   * (the runner refuses the arm otherwise), so what summary.json states is what the samples sent; the flat fields above are
   * derived from it (`maxTokens` = its base, `reasoning`, `deadlineMs` = its `sampleDeadline.maxMs`, `sampleTemperatures`)
   */
  synthesizer?: SynthesizerGeneration;
  /**
   * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §3: the pinned S2 mechanisms of an arm that can RUN them.
   * Absent on every arm today (F05): the block rode on `jev-on-next*`, whose mode is `jev-on`, where no S2
   * mechanism is reachable — nothing sets `PromptInput.prefixOrder`, `onFirstByte` is forwarded only on the
   * synthesizer sample path, and hedging plus the §3.4 cap live in `src/synth/llm/source.ts`. It comes back with
   * F17 (§9.1), on whichever arm the mechanisms are wired onto. Absent is what "S2 is off here" means.
   */
  s2?: S2Generation;
}

/** contract 1.9 (Fastlane) §3.2–§3.4: the pinned S2 generation mechanisms (bench/conditions.ts `S2_GENERATION`). */
export interface S2Generation {
  /** §3.2: one hedge per round, issued at clamp(`ttfbP50Multiple` × running TTFB p50, `afterMsMin`, `afterMsMax`) */
  hedges: { perRound: number; afterMsMin: number; afterMsMax: number; ttfbP50Multiple: number };
  /** §3.3: 'byte-stable' = the system → repo map → files → window prefix order; 'legacy' = today's assembly */
  prefix: 'byte-stable' | 'legacy';
  /** §3.4: the reasoning cap applied on the cheap classes only; null = uncapped */
  reasoningMaxTokens: number | null;
}

/**
 * contract 1.9 (Fastlane) §8.1 / F05: the §3 generation path as a STATE of the run, not a promise made before it.
 * `'partial'` is the honest answer when some of the run's steps reported S2 and others did not — it is never rounded
 * up to `'on'`, because the arm's whole purpose is a one-mechanism contrast.
 */
export type S2State = 'on' | 'partial' | 'off';

/** contract 1.9 (Fastlane) §8.1: which of the wave's three mechanisms an arm runs with (bench/conditions.ts `armMechanisms`). */
export interface ArmMechanisms {
  fastPath: 'off' | 'auto';
  routers: boolean;
  /**
   * F05: what the RUN did, never a constant. `armMechanisms` yields the arm's pinned value and refuses to pin
   * anything but `'off'` on an arm whose mode cannot honour it — the predicate is `s2ReachableOn`
   * (`src/synth/llm/hedge.ts`), which asks `s2Mode`, the resolver that reads `EngineOptions.s2`, rather than
   * keeping a mode list of its own. (F05 kept one and it said `'llm-jev'`; F25 then built the reader on `jev-on`
   * and the two lists were exact opposites, which is why the question is now asked in one place.)
   * `conditionConfig`'s `observed` argument overrides the pin with the value read off the run's own records at the
   * end of the run, so the record cannot disagree with what ran in either direction.
   */
  s2: S2State;
}

export interface ConditionConfig {
  condition: BenchCondition;
  /** the engine mode behind the arm (bench/conditions.ts `engineModeOf`) */
  mode: EngineMode;
  generatorModel: string;
  deciderModel: string | null;
  /** = generation.temperature / generation.maxTokens (kept flat for older readers of summary.json) */
  temperature: number | null;
  maxTokens: number;
  generation: PinnedGeneration;
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
  /**
   * contract 1.9 (Fastlane) §8.1: the wave mechanisms this arm ran with. Recorded on every arm (all-off on the six older
   * ones) so a results directory answers "was the fast path armed?" from summary.json alone — the question every row of
   * §8.3 is conditional on. "Ran with" is meant literally: F05 found `s2` recorded as `true` on two arms that could not
   * reach a single S2 mechanism, so `s2` is now clamped by the arm's mode and overridden by what the run reported.
   */
  mechanisms: ArmMechanisms;
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
/** Which per-step token series of a record a curve or mean is computed over. */
export type TokenSeries = 'tokensPerStep' | 'generatorTokensPerStep' | 'jevTokensPerStep';
/** mean over all executed steps of all runs (steps, not runs, as the unit), with the step count */
export interface MeanTokensPerStep {
  mean: number | null;
  steps: number;
}

export interface ConditionMetrics {
  condition: BenchCondition;
  tasks: number;
  evaluated: number;
  passed: number;
  passRate: number | null;
  /** "passed/evaluated (n)" */
  passRateText: string;
  /** docs/LLM-JEV-DESIGN.md §10.4: Wilson 95 % interval on the pass rate; null when nothing was evaluated */
  passRateWilson: { lo: number; hi: number } | null;
  unevaluated: string[];
  unsupported: string[];
  notRun: string[];
  stepsToSolve: Stat & { values: number[] };
  solveCurve: SolvePoint[];
  stepsUsed: Stat;
  stopReasons: Record<string, number>;
  /** combined generator + Jev */
  tokensPerStepCurve: TokensPoint[];
  generatorTokensPerStepCurve: TokensPoint[];
  jevTokensPerStepCurve: TokensPoint[];
  /** combined generator + Jev */
  meanTokensPerStep: MeanTokensPerStep;
  meanGeneratorTokensPerStep: MeanTokensPerStep;
  meanJevTokensPerStep: MeanTokensPerStep;
  jevLatencyMs: { p50: number | null; p95: number | null; n: number };
  jevRequests: number;
  jevQuestions: number;
  /** Σ generatorCalls over runs that ran (0 by construction for jev-only; a non-zero value there marked records invalid) */
  generatorCalls: number;
  blocked: number;
  reviews: number;
  declined: number;
  loops: number;
  replans: number;
  reads: { total: number; meanPerRun: number | null };
  cost: { generator: number; jev: number; total: number };
  /** §1.3 criterion 4: total $ over the runs / passed tasks; null without a pass */
  costPerSolved: number | null;
  wallMs: Stat;
  /** §10.4: the arm's generator calls summed over the runs' generator.jsonl (zeros when no run wrote one) */
  generator: GeneratorCallsSummary;
  /** §10.4: the arm's synthesizer facts summed over the runs' steps.jsonl (zeros when no run wrote one) */
  synth: StepsSummary;
  /** llm-sieve: Σ stub-answered requests */
  stubbedJevRequests: number;
  modelDrift: string[];
  runsWithError: string[];
}

export interface PairedRow {
  task: string;
  pass: Record<string, boolean | null>;
  steps: Record<string, number>;
  reads: Record<string, number>;
  cost: Record<string, number>;
  wallMs: Record<string, number>;
}

export interface SuiteComparison {
  suite: BenchSuite;
  conditions: BenchCondition[];
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
  conditionOrder: BenchCondition[];
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
  records: BenchRecord[];
  summary: Summary;
  comparisonMarkdown: string;
}

export type { BenchStopReason };
