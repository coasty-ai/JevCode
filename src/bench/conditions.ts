/**
 * The bench conditions (DESIGN.md §13, docs/JEV-ONLY.md, docs/LLM-JEV-DESIGN.md §10.1): jev-on is the full engine,
 * jev-off the generator-only engine, jev-only the full engine with a Synthesizer in the propose stage and the
 * NullProvider in the generator slot (no generating LLM; any generator usage invalidates the record), llm-jev the full
 * engine with the Synthesizer AND the real provider (the generating LLM is a candidate source inside the synthesizer;
 * generator calls are recorded, never asserted zero). The two attribution arms of §10.1 map onto those engines:
 * llm-sieve = the llm-jev engine with the stub Decider (zero Jev requests) and the synthesizer in `mode: 'llm-sieve'`
 * (every Jev question replaced by its code default); jev-off-tuned = the jev-off engine behind the tuned provider
 * (§4 generator hygiene: max_tokens 1,500, reasoning effort low, a 20 s per-call deadline that drops the call — the
 * propose stage ends the step without a retry — `length` → doubled once, plan capped at 200 chars). Everything that must
 * be identical across conditions — and everything that is PINNED per condition, the generation parameters first of all —
 * is built here so it is recorded verbatim in summary.json.conditions: the synthesizer arms' parameters are the ONE
 * `SynthesizerGeneration` object handed to the synthesizer factory and echoed back (the runner refuses an arm whose
 * synthesizer does not echo its mode and generation), the tuned arm's are the tuned provider's own parameters.
 */
import { lookupPricing } from '../config/defaults.js';
import type { BenchCondition, BenchDeps, BenchSuite, ConfigRecordValue, Confirmer, Decider, Engine, EngineMode, EngineOptions, GenerateReasoning, Provider, SpendMeter, Synthesizer, SynthesizerArmMode, SynthesizerGeneration } from '../core/types.js';
import { AbortError, ConfigError } from '../errors.js';
import { LLM_DEFAULT_GENERATION, LLM_DEFAULT_REASONING } from '../synth/llm/source.js';
import { STUB_DECIDER_MODEL } from './stub-decider.js';
import { JEV_OFF_MODEL, jevOffModeFrom } from '../jev/off.js';
import { PLAN_CAP_CHARS, type TunedProviderParams } from './tuned-provider.js';
import type { ArmMechanisms, BenchOptions, ConditionConfig, PinnedGeneration, S2Generation, ServedRate } from './types.js';

export const CONDITION_ORDER: readonly BenchCondition[] = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned', 'jev-on-next', 'jev-on-next-nofast'];

/**
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §8.1: the two arms of the LLM-loop wave. `jev-on-next` is the `jev-on`
 * engine with the router table, the synth fast path armed and the S2 generation mechanisms on; `jev-on-next-nofast` is the
 * same arm with the fast path off. They are bench-side substitutions on the `jev-on` mode exactly as `jev-off-tuned` is one
 * on `jev-off`: the arm's mechanisms are PINNED here (`armMechanisms`) and recorded in summary.json, so a run directory says
 * which mechanisms were live rather than leaving it to be inferred from the engine's defaults.
 */
export const NEXT_ARMS: readonly BenchCondition[] = ['jev-on-next', 'jev-on-next-nofast'];

export function isNextArm(condition: BenchCondition): boolean {
  return NEXT_ARMS.includes(condition);
}

/**
 * The three mechanisms of the wave, per arm (§8.1 arm table; the shape lives in bench/types.ts beside `ConditionConfig`,
 * which records it). `fastPath: 'auto'` = armed, the stage-1 predicate decides per step (§4.3); `routers` = the §2 router
 * table; `s2` = the §3 generation path, whose pinned parameters ride on `PinnedGeneration.s2`.
 */
export function armMechanisms(condition: BenchCondition): ArmMechanisms {
  switch (condition) {
    case 'jev-on-next':
      return { fastPath: 'auto', routers: true, s2: true };
    case 'jev-on-next-nofast':
      // §8.1: the single most valuable device in the plan — everything jev-on-next has EXCEPT route R9
      return { fastPath: 'off', routers: true, s2: true };
    default:
      return { fastPath: 'off', routers: false, s2: false };
  }
}

/**
 * §8.2 / §6 row 15: the fast path runs test commands of its own inside the step, so an arm that can enter it is measured at
 * `--concurrency 1` — otherwise its wall is a function of how many other tasks shared the machine, and neither R-b
 * (`fastPath.wallMs <= budgetMs`) nor prediction (b) (median wall) means anything. The control arm is held to the same
 * concurrency so the pair is comparable: a paired contrast whose two arms ran at different concurrencies is not one.
 */
export function requiresSerialBench(conditions: readonly BenchCondition[]): boolean {
  return conditions.some(isNextArm);
}

/** The engine mode an arm runs on (docs/LLM-JEV-DESIGN.md §10.1): the attribution arms are bench-side substitutions on an existing mode. */
export function engineModeOf(condition: BenchCondition): EngineMode {
  switch (condition) {
    case 'llm-sieve':
      return 'llm-jev';
    case 'jev-off-tuned':
      return 'jev-off';
    case 'jev-on-next':
    case 'jev-on-next-nofast':
      // contract 1.9 (Fastlane) §8.1: the wave's arms are the jev-on engine with mechanisms switched on, never a new mode
      return 'jev-on';
    default:
      return condition;
  }
}

/** jev-only, llm-jev and llm-sieve put a Synthesizer in the propose stage (docs/JEV-ONLY.md, docs/LLM-JEV-DESIGN.md §3). */
export function usesSynthesizer(condition: BenchCondition): boolean {
  const mode = engineModeOf(condition);
  return mode === 'jev-only' || mode === 'llm-jev';
}

/** The synthesizer's mode for an arm (null when the arm has no synthesizer). */
export function synthesizerModeOf(condition: BenchCondition): SynthesizerArmMode | null {
  if (condition === 'llm-sieve') return 'llm-sieve';
  const mode = engineModeOf(condition);
  return mode === 'jev-only' || mode === 'llm-jev' ? mode : null;
}

/** llm-sieve: the decider slot holds the stub (bench/stub-decider.ts); zero Jev requests by construction. */
export function usesStubDecider(condition: BenchCondition): boolean {
  return condition === 'llm-sieve';
}

/** jev-off-tuned: the provider slot holds the tuned wrapper (bench/tuned-provider.ts). */
export function usesTunedProvider(condition: BenchCondition): boolean {
  return condition === 'jev-off-tuned';
}

/** a bench with a synthesizer condition needs BenchDeps.createSynthesizer */
export function requiresSynthesizer(conditions: readonly BenchCondition[]): boolean {
  return conditions.some(usesSynthesizer);
}
/** what summary.json records as the generator model of the jev-only condition (NullProvider.model) */
export const NULL_GENERATOR_MODEL = 'none (jev-only)';

/** Bench runs are unattended: every review is declined, never auto-approved. */
export const alwaysDecline: Confirmer = {
  identity: 'no reviewer in bench runs',
  confirm(_req, opts) {
    if (opts.signal.aborted) return Promise.reject(new AbortError('human_abort'));
    return Promise.resolve(false);
  },
};

export function isBenchCondition(s: string): s is BenchCondition {
  return (CONDITION_ORDER as readonly string[]).includes(s);
}

/** Every arm but jev-only calls a generating LLM; a bench of jev-only alone needs no generator provider or key. */
export function requiresGenerator(conditions: readonly BenchCondition[]): boolean {
  return conditions.some((c) => c !== 'jev-only');
}

export function parseConditions(text: string): BenchCondition[] {
  const out: BenchCondition[] = [];
  for (const raw of text.split(',')) {
    const c = raw.trim();
    if (c === '') continue;
    if (!isBenchCondition(c)) throw new ConfigError(`--conditions: unknown condition "${c}" (use ${CONDITION_ORDER.join(', ')})`, { setting: 'conditions' });
    if (!out.includes(c)) out.push(c);
  }
  if (out.length === 0) throw new ConfigError('--conditions: at least one condition is required', { setting: 'conditions' });
  return out;
}

// ---------------------------------------------------------------------------------------
// Pinned generation parameters (docs/LLM-JEV-DESIGN.md §10.1; the user's config never reaches an arm)
// ---------------------------------------------------------------------------------------

export const GLM_FLASH_MODEL = 'z-ai/glm-5.3-flash';
/** docs/LLM-JEV-DESIGN.md §8 / DECISIONS 2026-09-21: the provider that serves GLM 5.3 flash bills 5/3× the models-API table. */
export const GLM_FLASH_SERVED_RATE: ServedRate = { inputPerM: 0.15, outputPerM: 0.5 };

/** The rate estimates are priced at: the measured served rate for GLM flash, the pricing table for anything else (zeros when unknown). */
export function servedRateFor(generatorModel: string): ServedRate {
  if (generatorModel.trim().toLowerCase() === GLM_FLASH_MODEL) return { ...GLM_FLASH_SERVED_RATE };
  const { pricing } = lookupPricing(generatorModel);
  return { inputPerM: pricing.inputPerM, outputPerM: pricing.outputPerM };
}

/** §10.1 `jev-off`: exactly the checked-in baseline runs (`bench/results/glm-jev-off-*`): no `reasoning`, no deadline, 4,096 tokens. */
export const BASELINE_MAX_TOKENS = 4096;
/** §10.1 `jev-off-tuned`: the §4 hygiene where the action grammar allows it. */
export const TUNED_MAX_TOKENS = 1500;
/** §10.1: 20 s per call on the QuixBugs / ladder class, 30 s on repositories (the §4.8 sample deadlines) */
export const TUNED_DEADLINE_MS = 20_000;
export const TUNED_REPOSITORY_DEADLINE_MS = 30_000;
/**
 * §4.12 / §10.2 finding (a): OpenRouter answers `reasoning: {enabled: false}` with HTTP 400 on z-ai/glm-5.3* ("Reasoning is
 * mandatory for this endpoint"), so every hygiene arm asks for `{effort: 'low'}` — the LLM source's own default — and the
 * synthesizer arms' max_tokens base is the reasoning-on one.
 */
export const HYGIENE_REASONING: GenerateReasoning = LLM_DEFAULT_REASONING;
/** §10.1 `llm-jev` / `llm-sieve`: what the LLM source sends by default (§4.6 / §4.8), handed to the synthesizer verbatim. */
export const SYNTHESIZER_GENERATION: SynthesizerGeneration = LLM_DEFAULT_GENERATION;

/**
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §3: the S2 generation mechanisms, PINNED so summary.json states what the
 * arm asked for rather than what the build happened to default to. `hedgeAfterMs = clamp(2 × running TTFB p50, 3 s, 8 s)`
 * with one hedge per round (§3.2, `LLM_HEDGES_PER_ROUND`); the byte-stable prefix order system → repo map → files → window
 * (§3.3 — it must not move `view: 'legacy'` bytes, which is the golden test's business, not this record's); the §3.4
 * reasoning cap on the cheap classes only, which is why it is a separate number and NOT folded into `reasoning`
 * (`{ effort: 'low' }` stays: §4.12, the served endpoint rejects `reasoning: {enabled:false}` outright).
 */
export const S2_GENERATION: S2Generation = { hedges: { perRound: 1, afterMsMin: 3_000, afterMsMax: 8_000, ttfbP50Multiple: 2 }, prefix: 'byte-stable', reasoningMaxTokens: 256 };

export function pinnedGeneration(condition: BenchCondition, generatorModel: string): PinnedGeneration {
  const servedRate = servedRateFor(generatorModel);
  switch (condition) {
    case 'jev-on':
    case 'jev-off':
      return { proposer: 'generator', temperature: null, maxTokens: BASELINE_MAX_TOKENS, reasoning: null, deadlineMs: null, lengthHandling: 'none', servedRate };
    case 'jev-off-tuned':
      return { proposer: 'generator', temperature: null, maxTokens: TUNED_MAX_TOKENS, reasoning: HYGIENE_REASONING, deadlineMs: TUNED_DEADLINE_MS, repositoryDeadlineMs: TUNED_REPOSITORY_DEADLINE_MS, lengthHandling: 'double-once', servedRate };
    case 'jev-on-next':
    case 'jev-on-next-nofast':
      // contract 1.9 (Fastlane) §8.1: "the jev-off-tuned object plus the S2 hedge/prefix fields". The proposer is the
      // GENERATOR — the fast path is a per-step detour that builds its own jev-only synthesizer (§4.2), it is not the
      // arm's proposer, which is why `usesSynthesizer` is false here and no SynthesizerGeneration is pinned.
      return {
        proposer: 'generator',
        temperature: null,
        maxTokens: TUNED_MAX_TOKENS,
        reasoning: HYGIENE_REASONING,
        deadlineMs: TUNED_DEADLINE_MS,
        repositoryDeadlineMs: TUNED_REPOSITORY_DEADLINE_MS,
        lengthHandling: 'double-once',
        servedRate,
        s2: S2_GENERATION,
      };
    case 'jev-only':
      // no generating LLM: the NullProvider throws if called; the values are the engine's inert defaults
      return { proposer: 'synthesizer', temperature: null, maxTokens: BASELINE_MAX_TOKENS, reasoning: null, deadlineMs: null, lengthHandling: 'none', servedRate: { inputPerM: 0, outputPerM: 0 } };
    case 'llm-jev':
    case 'llm-sieve': {
      // §4.6 / §4.8: temperature per sample (0, then 0.8), max_tokens 3,000 with reasoning on and doubled once after a `length` drop,
      // deadline clamp(2 × running p50, 10 s, 20 s) on the QuixBugs/ladder class and 30 s on repositories — every flat field
      // is read off the one object the synthesizer receives and echoes
      const g = SYNTHESIZER_GENERATION;
      return {
        proposer: 'synthesizer',
        temperature: null,
        sampleTemperatures: [g.sampleTemperature.first, g.sampleTemperature.rest],
        maxTokens: g.maxTokens,
        reasoning: g.reasoning,
        deadlineMs: g.sampleDeadline.maxMs,
        repositoryDeadlineMs: g.sampleDeadline.repositoryMs,
        lengthHandling: 'double-once',
        servedRate,
        synthesizer: g,
      };
    }
  }
}

/** The pinned generation the runner hands `createSynthesizer` for an arm (null for jev-only, which has no LLM source, and the generator arms). */
export function synthesizerGenerationOf(condition: BenchCondition, generatorModel: string): SynthesizerGeneration | null {
  return pinnedGeneration(condition, generatorModel).synthesizer ?? null;
}

/** SWE-bench and Terminal-Bench workspaces are repositories (§4.8 class); QuixBugs and the ladder are the cheap-test class. */
export function isRepositorySuite(suite: BenchSuite): boolean {
  return suite === 'swebench' || suite === 'terminal-bench';
}

/** The tuned provider's parameters for the jev-off-tuned arm, derived from the pinned generation so summary.json and the wrapper agree. */
export function tunedParamsFor(generatorModel: string, suite: BenchSuite): TunedProviderParams {
  const g = pinnedGeneration('jev-off-tuned', generatorModel);
  const deadlineMs = isRepositorySuite(suite) ? (g.repositoryDeadlineMs ?? TUNED_REPOSITORY_DEADLINE_MS) : (g.deadlineMs ?? TUNED_DEADLINE_MS);
  return { maxTokens: g.maxTokens, reasoning: g.reasoning ?? HYGIENE_REASONING, deadlineMs, lengthHandling: g.lengthHandling, servedRate: g.servedRate, planCapChars: PLAN_CAP_CHARS };
}

function deciderModelOf(condition: BenchCondition, opts: BenchOptions): string | null {
  if (engineModeOf(condition) === 'jev-off') return null;
  if (usesStubDecider(condition)) return STUB_DECIDER_MODEL;
  // HARNESS-NEXT-DESIGN §1.2: with the `--jev off` switch on, the slot holds the switch's double and summary.json says so
  if (jevOffModeFrom() !== null) return JEV_OFF_MODEL;
  return opts.deciderModel.configured;
}

export function conditionConfig(condition: BenchCondition, opts: BenchOptions, generatorModel: string): ConditionConfig {
  const model = condition === 'jev-only' ? NULL_GENERATOR_MODEL : generatorModel;
  const generation = pinnedGeneration(condition, model);
  return {
    condition,
    mode: engineModeOf(condition),
    generatorModel: model,
    deciderModel: deciderModelOf(condition, opts),
    temperature: generation.temperature,
    maxTokens: generation.maxTokens,
    generation,
    maxSteps: opts.limits.maxSteps,
    maxWallMs: opts.limits.maxWallMs,
    maxReplans: opts.limits.maxReplans,
    taskSpendCapUsd: opts.taskSpendCapUsd,
    sandboxProfile: opts.sandboxProfile,
    noNetwork: opts.noNetwork,
    commandTimeoutMs: opts.limits.commandTimeoutMs,
    maxCommandTimeoutMs: opts.limits.maxCommandTimeoutMs,
    maxOutputBytes: opts.limits.maxOutputBytes,
    completeThreshold: opts.limits.completeThreshold,
    impossibleThreshold: opts.limits.impossibleThreshold,
    mechanisms: armMechanisms(condition),
  };
}

export interface EngineBuildInput {
  condition: BenchCondition;
  task: string;
  workspace: string;
  provider: Provider;
  decider: Decider;
  meter: SpendMeter;
  /** synthesizer arms: the propose stage (required by createEngine in those modes) */
  synthesizer?: Synthesizer;
  resume?: { runId: string; force: boolean };
  now?: () => number;
  /** Terminal-Bench aux dir (stand-ins for /output, /results, /logs): the agent may write where the shimmed instruction says */
  extraWritableRoots?: readonly string[];
  extraReadableRoots?: readonly string[];
}

/**
 * EngineOptions for one run; only the mode, the task text, workspace, provider/decider/meter (and the synthesizer) differ
 * per pair. `generation` is the arm's PINNED parameters (never `opts.generation`, which is the user's config); the
 * llm-sieve arm pins its decider model to the stub's so the drift check reads the stub as the configured model.
 */
/** A per-worker copy of the config record — the entry and its `value` object (see buildEngineOptions). */
function copyConfigRecord(record: Record<string, ConfigRecordValue>): Record<string, ConfigRecordValue> {
  const out: Record<string, ConfigRecordValue> = {};
  for (const [k, v] of Object.entries(record)) out[k] = { value: typeof v.value === 'string' ? v.value : { ...v.value }, source: v.source };
  return out;
}

/**
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §5.2 / §7.1: `EngineOptions.fastPath` and `EngineOptions.routers`
 * are declared in `src/core/types.ts`, and this module was written before they landed there.
 * This intersection is the seam, and it is deliberately typed rather than cast: when the two
 * members land with the shapes §5.2 states, the intersection is redundant and everything still compiles; if either
 * lands with a DIFFERENT type, the intersection collapses and the assignment below fails to compile — a loud failure
 * at merge is the point, since the silent alternative is an arm that runs with both mechanisms off and measures nothing.
 */
export type WaveEngineOptions = EngineOptions & { fastPath?: 'auto' | 'off'; routers?: 'on' | 'off' };

export function buildEngineOptions(input: EngineBuildInput, opts: BenchOptions): WaveEngineOptions {
  const generation = pinnedGeneration(input.condition, input.provider.model);
  const out: WaveEngineOptions = {
    task: input.task,
    mode: engineModeOf(input.condition),
    workspace: input.workspace,
    runsDir: opts.runsDir,
    provider: input.provider,
    decider: input.decider,
    confirmer: alwaysDecline,
    meter: input.meter,
    limits: { ...opts.limits, spendCapUsd: opts.taskSpendCapUsd },
    sandboxProfile: opts.sandboxProfile,
    noNetwork: opts.noNetwork,
    // HARNESS-NEXT-DESIGN §6 S0 / §2 (mini-swe-agent v2.4.x "deep-copy per-worker config"): every pair gets its
    // own copy. `--concurrency N` runs N of these engines in one process, each writing its `configRecord` into its
    // own run dir; a shared object means one worker's engine can observe — or leave behind — another's edit, and
    // the symptom would be a run dir describing the wrong configuration rather than a crash. The record is
    // `ConfigRecordValue` is `{ value: string | { source; fingerprint }, source: string }`, so copying the entry
    // and its `value` object is a deep copy of the whole record.
    configRecord: copyConfigRecord(opts.configRecord),
    redact: opts.redact,
    secretPaths: [...opts.secretPaths],
    generation: { temperature: generation.temperature, maxTokens: generation.maxTokens },
    // the model the engine's drift check compares against: the stub's, the `--jev off` switch's, or the configured one
    deciderModel: usesStubDecider(input.condition) ? { configured: STUB_DECIDER_MODEL, pinned: true } : jevOffModeFrom() !== null ? { configured: JEV_OFF_MODEL, pinned: true } : { configured: opts.deciderModel.configured, pinned: opts.deciderModel.pinned },
    // TUI-DESIGN §15.2 bench/conditions.ts row: a bench run is its own session and writes neither index.jsonl nor history.jsonl (§1)
    session: { sessionId: null, parentRunId: null, source: 'bench' },
  };
  // docs/COORDINATION-DESIGN.md §8.2 / review D7: every frozen arm keeps HEAD's prompt until a head-to-head has measured
  // the relaxed context, or the baselines in `experiments/results/` stop being comparable the moment §8 lands. Pass
  // `contextPolicy: { view: 'relaxed' }` (or set `JEVCODE_BENCH_CONTEXT=relaxed`) for the arm that measures it.
  out.contextPolicy = { view: process.env['JEVCODE_BENCH_CONTEXT'] === 'relaxed' ? 'relaxed' : 'legacy' };
  if (input.synthesizer) out.synthesizer = input.synthesizer;
  if (input.resume) out.resume = input.resume;
  if (input.now) out.now = input.now;
  if (input.extraWritableRoots && input.extraWritableRoots.length > 0) out.extraWritableRoots = [...input.extraWritableRoots];
  if (input.extraReadableRoots && input.extraReadableRoots.length > 0) out.extraReadableRoots = [...input.extraReadableRoots];
  // contract 1.9 (Fastlane) §8.1: the arm's mechanisms are pinned per condition, never read from the user's env — an arm
  // whose fast path was on because JEVCODE_FASTPATH happened to be exported is not the arm summary.json says it is.
  // Writing the option is only half of it: both mechanisms are resolved env-FIRST inside the engine, so the runner
  // calls `pinMechanismEnv` before any engine is built and the pinned value below is the effective one.
  //
  // The six older arms get an explicit `fastPath: 'off'`, which is a DIVERGENCE from the product default
  // ('auto' in `jev-on`): a bench `jev-on` row measures the engine WITHOUT route R9. That is deliberate — it is
  // the same-build, no-fast-path reference the fast path is read against, and §8.5 says the default-mode flip is a separate
  // decision on these rows — but it is recorded here, in `armMechanisms` and in docs/DESIGN.md §22.8 rather than left
  // to be discovered from a table. A run that wants the shipped default must use `jev-on-next-nofast`'s sibling arm or
  // the product itself, not the `jev-on` bench row.
  const mech = armMechanisms(input.condition);
  out.fastPath = mech.fastPath;
  out.routers = mech.routers ? 'on' : 'off';
  return out;
}

/**
 * contract 1.9 (Fastlane) §8.1: the env switches that would otherwise BEAT the arm's pinned mechanisms.
 *
 * Both are resolved inside the engine before the option: `resolveFastPathOption` reads `JEVCODE_FASTPATH`
 * first in both directions, and `routersOn` ORs `JEVCODE_ROUTERS=on` in. An exported `JEVCODE_FASTPATH=off`
 * therefore runs `jev-on-next` DISARMED while `summary.json` records `mechanisms.fastPath: 'auto'`, and an exported
 * `JEVCODE_FASTPATH=auto` runs the `jev-on-next-nofast` CONTROL armed while it records `'off'` — which destroys the
 * one-mechanism contrast §8.5 clause 4 rests on, silently, in the direction that makes the fast path look better.
 */
export const MECHANISM_ENV_VARS: readonly string[] = ['JEVCODE_FASTPATH', 'JEVCODE_ROUTERS'];

/**
 * Removes those switches from the bench process's environment and returns what it removed, so the runner can say so
 * in the log. After this call the pinned option IS the option the engine resolves, which is what makes
 * `summary.json.conditions[arm].mechanisms` a record of the run rather than of an intention. `JEVCODE_WARM` and the
 * rest are left alone: they are documented escapes the recorded arms were taken under.
 */
export function pinMechanismEnv(env: Record<string, string | undefined> = process.env): { name: string; was: string }[] {
  const cleared: { name: string; was: string }[] = [];
  for (const name of MECHANISM_ENV_VARS) {
    const was = env[name];
    if (was === undefined) continue;
    cleared.push({ name, was });
    delete env[name];
  }
  return cleared;
}

/** jev-off and jev-off-tuned are the generator-only factory; every other arm the full engine (the synthesizer arms with `engineOpts.synthesizer` set). */
export function createEngineFor(condition: BenchCondition, engineOpts: EngineOptions, deps: BenchDeps): Promise<Engine> {
  return engineModeOf(condition) === 'jev-off' ? deps.createGeneratorOnlyEngine(engineOpts) : deps.createEngine(engineOpts);
}
