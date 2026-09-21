/**
 * The bench conditions (DESIGN.md §13, docs/JEV-ONLY.md): jev-on is the full engine, jev-off
 * the generator-only engine, jev-only the full engine with a Synthesizer in the propose stage
 * and the NullProvider in the generator slot (no generating LLM; any generator usage
 * invalidates the record). Everything that must be identical across conditions is built here
 * so it can be recorded verbatim in summary.json.conditions.
 */
import type { BenchDeps, Confirmer, Decider, Engine, EngineMode, EngineOptions, Provider, SpendMeter, Synthesizer } from '../core/types.js';
import { AbortError, ConfigError } from '../errors.js';
import type { BenchOptions, ConditionConfig } from './types.js';

export const CONDITION_ORDER: readonly EngineMode[] = ['jev-on', 'jev-off', 'jev-only'];
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

export function isEngineMode(s: string): s is EngineMode {
  return (CONDITION_ORDER as readonly string[]).includes(s);
}

/** jev-on and jev-off call a generating LLM; a bench of jev-only alone needs no generator provider or key. */
export function requiresGenerator(conditions: readonly EngineMode[]): boolean {
  return conditions.some((c) => c !== 'jev-only');
}

export function parseConditions(text: string): EngineMode[] {
  const out: EngineMode[] = [];
  for (const raw of text.split(',')) {
    const c = raw.trim();
    if (c === '') continue;
    if (!isEngineMode(c)) throw new ConfigError(`--conditions: unknown condition "${c}" (use ${CONDITION_ORDER.join(', ')})`, { setting: 'conditions' });
    if (!out.includes(c)) out.push(c);
  }
  if (out.length === 0) throw new ConfigError('--conditions: at least one condition is required', { setting: 'conditions' });
  return out;
}

export function conditionConfig(mode: EngineMode, opts: BenchOptions, generatorModel: string): ConditionConfig {
  return {
    mode,
    generatorModel: mode === 'jev-only' ? NULL_GENERATOR_MODEL : generatorModel,
    deciderModel: mode === 'jev-off' ? null : opts.deciderModel.configured,
    temperature: opts.generation.temperature,
    maxTokens: opts.generation.maxTokens,
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
  };
}

export interface EngineBuildInput {
  mode: EngineMode;
  task: string;
  workspace: string;
  provider: Provider;
  decider: Decider;
  meter: SpendMeter;
  /** jev-only: the propose stage (required by createEngine in that mode) */
  synthesizer?: Synthesizer;
  resume?: { runId: string; force: boolean };
  now?: () => number;
  /** Terminal-Bench aux dir (stand-ins for /output, /results, /logs): the agent may write where the shimmed instruction says */
  extraWritableRoots?: readonly string[];
  extraReadableRoots?: readonly string[];
}

/** EngineOptions for one run; only `mode`, the task text, workspace, provider/decider/meter (and the jev-only synthesizer) differ per pair. */
export function buildEngineOptions(input: EngineBuildInput, opts: BenchOptions): EngineOptions {
  const out: EngineOptions = {
    task: input.task,
    mode: input.mode,
    workspace: input.workspace,
    runsDir: opts.runsDir,
    provider: input.provider,
    decider: input.decider,
    confirmer: alwaysDecline,
    meter: input.meter,
    limits: { ...opts.limits, spendCapUsd: opts.taskSpendCapUsd },
    sandboxProfile: opts.sandboxProfile,
    noNetwork: opts.noNetwork,
    configRecord: opts.configRecord,
    redact: opts.redact,
    secretPaths: opts.secretPaths,
    generation: { temperature: opts.generation.temperature, maxTokens: opts.generation.maxTokens },
    deciderModel: { configured: opts.deciderModel.configured, pinned: opts.deciderModel.pinned },
    // TUI-DESIGN §15.2 bench/conditions.ts row: a bench run is its own session and writes neither index.jsonl nor history.jsonl (§1)
    session: { sessionId: null, parentRunId: null, source: 'bench' },
  };
  if (input.synthesizer) out.synthesizer = input.synthesizer;
  if (input.resume) out.resume = input.resume;
  if (input.now) out.now = input.now;
  if (input.extraWritableRoots && input.extraWritableRoots.length > 0) out.extraWritableRoots = [...input.extraWritableRoots];
  if (input.extraReadableRoots && input.extraReadableRoots.length > 0) out.extraReadableRoots = [...input.extraReadableRoots];
  return out;
}

/** jev-on and jev-only are the full engine (the latter with `engineOpts.synthesizer` set); jev-off the generator-only factory. */
export function createEngineFor(mode: EngineMode, engineOpts: EngineOptions, deps: BenchDeps): Promise<Engine> {
  return mode === 'jev-off' ? deps.createGeneratorOnlyEngine(engineOpts) : deps.createEngine(engineOpts);
}
