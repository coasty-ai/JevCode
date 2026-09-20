/** contract 1.1 (TUI-DESIGN §13.5, §15 items 1 and 19): exit codes for the new stop reasons, signals and a degraded checkpoint. */
import { describe, expect, it } from 'vitest';
import type { SerializedError, StopReason } from '../../../src/core/types.js';
import { AbortError, BudgetError, EXIT_CODES } from '../../../src/errors.js';
import { BUDGET_STOP_REASONS, classifyAbort, exitCodeFor, isBudgetStop } from '../../../src/loop/stop.js';

const jevHttp: SerializedError = { name: 'JevHttpError', code: 'jev_http', message: 'Jev HTTP 429', exitCode: 5, status: 429, retryable: true, side: 'jev', requestId: null };

describe('exitCodeFor (TUI-DESIGN §13.5)', () => {
  it('human_pause and token_cap are the exit-4 family, like every other budget stop', () => {
    expect(exitCodeFor('human_pause')).toBe(4);
    expect(exitCodeFor('token_cap')).toBe(4);
    for (const r of ['max_steps', 'spend_cap', 'wall_time', 'max_replans', 'replan_stop', 'impossible'] as const) expect(exitCodeFor(r)).toBe(4);
  });

  it('the existing two-argument calls are unchanged', () => {
    expect(exitCodeFor('complete')).toBe(0);
    expect(exitCodeFor('generator_done')).toBe(0);
    expect(exitCodeFor('human_abort')).toBe(130);
    expect(exitCodeFor('signal')).toBe(130);
    expect(exitCodeFor('error')).toBe(1);
    expect(exitCodeFor('error', jevHttp)).toBe(5);
  });

  it('a signal stop is refined by the signal name: SIGINT 130, SIGTERM 143, SIGHUP 129', () => {
    expect(exitCodeFor('signal', undefined, false, 'SIGINT')).toBe(130);
    expect(exitCodeFor('signal', undefined, false, 'SIGTERM')).toBe(143);
    expect(exitCodeFor('signal', undefined, false, 'SIGHUP')).toBe(129);
    expect(exitCodeFor('signal', undefined, false, undefined)).toBe(130);
    // the signal name only refines a 'signal' stop
    expect(exitCodeFor('human_abort', undefined, false, 'SIGTERM')).toBe(130);
    expect(exitCodeFor('complete', undefined, false, 'SIGTERM')).toBe(0);
  });

  it('a degraded checkpoint turns every non-error stop into 3 (complete included); an error keeps its own code', () => {
    const all: StopReason[] = ['complete', 'max_steps', 'spend_cap', 'wall_time', 'max_replans', 'human_abort', 'signal', 'replan_stop', 'impossible', 'generator_done', 'human_pause', 'token_cap'];
    for (const r of all) expect(exitCodeFor(r, undefined, true)).toBe(3);
    expect(exitCodeFor('signal', undefined, true, 'SIGTERM')).toBe(3);
    expect(exitCodeFor('error', jevHttp, true)).toBe(5);
    expect(exitCodeFor('error', undefined, true)).toBe(1);
  });

  it('EXIT_CODES names the SIGHUP code', () => {
    expect(EXIT_CODES.sighup).toBe(129);
    expect(EXIT_CODES.sigterm).toBe(143);
    expect(EXIT_CODES.sigint).toBe(130);
  });
});

describe('budget stop set (TUI-DESIGN §8.7, §15 item 19)', () => {
  it('token_cap is a budget stop; human_pause is not (a /resume proceeds without --force)', () => {
    expect(BUDGET_STOP_REASONS).toContain('token_cap');
    expect(BUDGET_STOP_REASONS).not.toContain('human_pause');
    expect(isBudgetStop('token_cap')).toBe(true);
    expect(isBudgetStop('human_pause')).toBe(false);
  });

  it('classifyAbort maps a BudgetError(token_cap) to the token_cap stop', () => {
    expect(classifyAbort(new BudgetError('token_cap'))).toEqual({ interrupt: 'wall_time', stop: 'token_cap' });
  });
});

describe('AbortError.signalName (TUI-DESIGN §15 item 19)', () => {
  it('defaults to null and keeps the 130 / 130 / 1 exit codes', () => {
    expect(new AbortError('signal').signalName).toBeNull();
    expect(new AbortError('signal').exitCode).toBe(130);
    expect(new AbortError('human_abort').exitCode).toBe(130);
    expect(new AbortError('error').exitCode).toBe(1);
  });

  it('carries the signal, and the exit code follows it', () => {
    const term = new AbortError('signal', 'SIGTERM');
    expect(term.signalName).toBe('SIGTERM');
    expect(term.exitCode).toBe(143);
    expect(new AbortError('signal', 'SIGHUP').exitCode).toBe(129);
    expect(new AbortError('signal', 'SIGINT').exitCode).toBe(130);
    expect(classifyAbort(term)).toEqual({ interrupt: 'signal', stop: 'signal' });
    expect(exitCodeFor(classifyAbort(term).stop, undefined, false, term.signalName ?? undefined)).toBe(143);
  });
});
