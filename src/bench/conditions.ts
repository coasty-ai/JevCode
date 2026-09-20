/**
 * The two bench conditions (DESIGN.md §13): jev-on is the full engine, jev-off the
 * generator-only engine. Everything that must be identical across them is built here so it
 * can be recorded verbatim in summary.json.conditions.
 */
import type { BenchDeps, Confirmer, Decider, Engine, EngineMode, EngineOptions, Provider, SpendMeter } from '../core/types.js';
import { AbortError, ConfigError } from '../errors.js';
import type { BenchOptions, ConditionConfig } from './types.js';

export const CONDITION_ORDER: readonly EngineMode[] = ['jev-on', 'jev-off'];

/** Bench runs are unattended: every review is declined, never auto-approved. */
export const alwaysDecline: Confirmer = {
  identity: 'no reviewer in bench runs',
  confirm(_req, opts) {
    if (opts.signal.aborted) return Promise.reject(new AbortError('human_abort'));
    return Promise.resolve(false);
  },
};

export function isEngineMode(s: string): s is EngineMode {
  return s === 'jev-on' || s === 'jev-off';
}

export function parseConditions(text: string): EngineMode[] {
  const out: EngineMode[] = [];
  for (const raw of text.split(',')) {
    const c = raw.trim();
    if (c === '') continue;
    if (!isEngineMode(c)) throw new ConfigError(`--conditions: unknown condition "${c}" (use jev-on, jev-off)`, { setting: 'conditions' });
    if (!out.includes(c)) out.push(c);
  }
  if (out.length === 0) throw new ConfigError('--conditions: at least one condition is required', { setting: 'conditions' });
  return out;
}

export function conditionConfig(mode: EngineMode, opts: BenchOptions, generatorModel: string): ConditionConfig {
  return {
    mode,
    generatorModel,
    deciderModel: mode === 'jev-on' ? opts.deciderModel.configured : null,
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
  resume?: { runId: string; force: boolean };
  now?: () => number;
  /** Terminal-Bench aux dir (stand-ins for /output, /results, /logs): the agent may write where the shimmed instruction says */
  extraWritableRoots?: readonly string[];
  extraReadableRoots?: readonly string[];
}

/** EngineOptions for one run; only `mode`, the task text, workspace, provider/decider/meter differ per pair. */
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
  };
  if (input.resume) out.resume = input.resume;
  if (input.now) out.now = input.now;
  if (input.extraWritableRoots && input.extraWritableRoots.length > 0) out.extraWritableRoots = [...input.extraWritableRoots];
  if (input.extraReadableRoots && input.extraReadableRoots.length > 0) out.extraReadableRoots = [...input.extraReadableRoots];
  return out;
}

export function createEngineFor(mode: EngineMode, engineOpts: EngineOptions, deps: BenchDeps): Promise<Engine> {
  return mode === 'jev-on' ? deps.createEngine(engineOpts) : deps.createGeneratorOnlyEngine(engineOpts);
}
