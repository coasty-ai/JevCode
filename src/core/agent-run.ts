/**
 * AGENT-LOOP-DESIGN §A1 / §A5: the ONE predicate for "this agent run was a reply" — the model answered in prose with no tool call,
 * so it changed nothing and ran nothing. The engine stops such a run as `answered` (exit 0); the TUI renders it as a chat reply (no run
 * header, no step rows, no stop line); the session keeps it out of titles, the recent-session hint, the /resume picker and `jevcode
 * sessions` titles. Every consumer imports this function so the decision is made in one place.
 *
 * Over step records: true when the run has at least one step and every step is an agent step of kind `finish` with no calls. A run
 * with any `observe` (even read-only tools), `act` or `verify` step is not a reply. Legacy-mode steps (no `agent` summary) are never
 * replies. Zero steps (a run stopped before its first step) is not a reply either.
 */
import type { StepRecord } from './types.js';

export function isReplyOnlyRun(steps: readonly Pick<StepRecord, 'agent'>[]): boolean {
  if (steps.length === 0) return false;
  return steps.every((s) => s.agent !== undefined && s.agent.kind === 'finish' && s.agent.calls.length === 0);
}
