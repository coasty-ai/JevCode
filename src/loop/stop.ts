/**
 * Stop helpers (DESIGN.md §6 `stop(reason)`, §11 exit codes): pure functions the engine's
 * single exit path uses to assemble the RunResult and derive exit codes and transcript lines.
 */
import type { CheckpointState, EngineMode, InterruptReason, RunResult, SerializedError, SignalName, StopReason } from '../core/types.js';
import { EXIT_CODES, isAbortError, isBudgetError, toJevCodeError } from '../errors.js';

/** TUI-DESIGN §15 item 19: 'token_cap' is a budget stop; 'human_pause' is not (a /resume proceeds without --force). */
export const BUDGET_STOP_REASONS: readonly StopReason[] = ['max_steps', 'spend_cap', 'wall_time', 'max_replans', 'replan_stop', 'impossible', 'token_cap'];

export function isBudgetStop(reason: StopReason): boolean {
  return BUDGET_STOP_REASONS.includes(reason);
}

/**
 * Exit code for a StopReason (§11 table; TUI-DESIGN §13.5). The one function main.tsx and the engine use.
 * `degraded` (a checkpoint that could not be written) turns every non-error stop into 3: the run is not
 * resumable, `complete` included. `signal` refines a 'signal' stop: SIGTERM 143, SIGHUP 129, else 130.
 * 'human_pause' and 'token_cap' fall in the exit-4 (budget) family. The two new parameters are optional,
 * so every existing caller compiles unchanged.
 */
export function exitCodeFor(reason: StopReason, error?: SerializedError, degraded = false, signal?: SignalName): number {
  if (degraded && reason !== 'error') return EXIT_CODES.checkpoint;
  switch (reason) {
    case 'complete':
    case 'generator_done':
      return EXIT_CODES.ok;
    case 'human_abort':
      return EXIT_CODES.sigint;
    case 'signal':
      return signal === 'SIGTERM' ? EXIT_CODES.sigterm : signal === 'SIGHUP' ? EXIT_CODES.sighup : EXIT_CODES.sigint;
    case 'error':
      return error?.exitCode ?? EXIT_CODES.unexpected;
    default:
      // max_steps, spend_cap, wall_time, max_replans, replan_stop, impossible, human_pause, token_cap
      return EXIT_CODES.budget;
  }
}

/** Interrupt reason and StopReason derived from an aborted signal's reason. */
export function classifyAbort(reason: unknown): { interrupt: InterruptReason; stop: StopReason } {
  if (isBudgetError(reason)) return { interrupt: 'wall_time', stop: reason.reason === 'wall_time' ? 'wall_time' : reason.reason };
  if (isAbortError(reason)) {
    if (reason.reason === 'human_abort') return { interrupt: 'human_abort', stop: 'human_abort' };
    if (reason.reason === 'signal') return { interrupt: 'signal', stop: 'signal' };
    return { interrupt: 'error', stop: 'error' };
  }
  return { interrupt: 'error', stop: 'error' };
}

export function serializeError(e: unknown, redact: (s: string) => string): SerializedError {
  const err = toJevCodeError(e);
  return { name: err.name, code: err.code, message: redact(err.message), exitCode: err.exitCode };
}

export function stopTranscriptLine(reason: StopReason, step: number, detail?: string): string {
  return `stop: ${reason} at step ${step}${detail ? ` (${detail})` : ''}`;
}

/** A per-source token series from a checkpoint: older checkpoints lack it, which reads as zeros of the combined series' length. */
export function tokenSeriesOrZeros(series: readonly number[] | undefined, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) out.push(series?.[i] ?? 0);
  return out;
}

export function assembleRunResult(input: {
  runId: string;
  mode: EngineMode;
  reason: StopReason;
  state: CheckpointState;
  error: SerializedError | null;
}): RunResult {
  const s = input.state;
  const result: RunResult = {
    runId: input.runId,
    mode: input.mode,
    stopReason: input.reason,
    steps: s.step,
    wallMs: s.wallMsUsed,
    usage: { generator: { ...s.spend.generator }, jev: { ...s.spend.jev } },
    timing: { ...s.timing },
    tokensPerStep: [...s.tokensPerStep],
    generatorTokensPerStep: tokenSeriesOrZeros(s.generatorTokensPerStep, s.tokensPerStep.length),
    jevTokensPerStep: tokenSeriesOrZeros(s.jevTokensPerStep, s.tokensPerStep.length),
    jevLatencyMs: [...s.jevLatencyMs],
    // older checkpoints (before the contract extension) have no counter: absent reads as 0
    jevQuestions: s.jevQuestions ?? 0,
    counters: { ...s.counters },
    finalPlan: s.plan,
    resolvedJevModel: s.resolvedJevModel,
    jevModelDrift: s.jevModelDrift ? { ...s.jevModelDrift } : null,
  };
  if (input.error) result.error = input.error;
  return result;
}
