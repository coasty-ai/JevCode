/**
 * Stop helpers (DESIGN.md §6 `stop(reason)`, §11 exit codes): pure functions the engine's
 * single exit path uses to assemble the RunResult and derive exit codes and transcript lines.
 */
import type { CheckpointState, EngineMode, InterruptReason, RunResult, SerializedError, StopReason } from '../core/types.js';
import { EXIT_CODES, isAbortError, isBudgetError, toJevCodeError } from '../errors.js';

export const BUDGET_STOP_REASONS: readonly StopReason[] = ['max_steps', 'spend_cap', 'wall_time', 'max_replans', 'replan_stop', 'impossible'];

export function isBudgetStop(reason: StopReason): boolean {
  return BUDGET_STOP_REASONS.includes(reason);
}

/** Exit code for a StopReason (§11 table). */
export function exitCodeFor(reason: StopReason, error?: SerializedError): number {
  switch (reason) {
    case 'complete':
    case 'generator_done':
      return EXIT_CODES.ok;
    case 'human_abort':
      return EXIT_CODES.sigint;
    case 'signal':
      return EXIT_CODES.sigint;
    case 'error':
      return error?.exitCode ?? EXIT_CODES.unexpected;
    default:
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
