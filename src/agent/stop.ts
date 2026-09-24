/**
 * The stop rules at a turn with no tool calls (docs/AGENT-LOOP-DESIGN.md §3.3), evaluated in order:
 *
 *  1. Continuation, narrow and at most twice per run: the turn was cut off at the output limit, or its last line
 *     announces an action and ends with `:` / `…` (never when it says "let me know"). Final answers never trigger it.
 *  2. Verification, at most twice per run: files changed since the last passing unscoped test run and a test command is
 *     known. If the model's own unscoped run after its last change failed, it gets one nudge with the counts; otherwise
 *     the harness runs the detected command itself (a `verify` step).
 *  3. Finish.
 *
 * The test command is never a model's choice: it is `detectTestCommand()`'s (`WorkspaceInfo.testCommand`).
 */
import type { TestCommand } from '../core/types.js';
import { AGENT_CONTINUE_MAX, AGENT_VERIFY_MAX } from './limits.js';
import { CONTINUE_CUT_NUDGE, CONTINUE_NUDGE, verifyFailedNudge } from './prompt.js';
import type { AgentStateV1 } from './state.js';

/** §3.3 rule 1(b); the curly apostrophe (`I’ll`) models often write counts as the straight one. */
export const ANNOUNCE_RE = /\b(I['’]ll|I will|Let me|Now I|Next,? I)\b/i;

/** `length` (OpenAI-style) or `max_tokens` (Anthropic): the reply hit the output limit. */
export function isCutOff(stopReason: string): boolean {
  return /^(length|max_tokens|max_output_tokens)$/i.test(stopReason.trim());
}

/** The last non-empty line announces a step it did not take (`Let me check the tests:`). */
export function announcesAction(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  const endsOpen = last.endsWith(':') || last.endsWith('…') || last.endsWith('...');
  return endsOpen && ANNOUNCE_RE.test(last) && !/let me know/i.test(last);
}

/** A run of the detected test command at the root, as detected: the only run that can verify (§3.3 "Passing"). */
export function isUnscopedTestRun(command: string, workdir: string | null, test: TestCommand | null): boolean {
  if (test === null || workdir !== null) return false;
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return norm(command) === norm(test.command);
}

export type StopDecision =
  | { kind: 'continue'; note: string }
  | { kind: 'verify_nudge'; note: string }
  | { kind: 'verify'; command: string }
  | { kind: 'finish' };

/** Apply the rules to a text-only turn. Pure: the caller updates the counters for the decision it acts on. */
export function decideStop(turn: { text: string; stopReason: string }, state: AgentStateV1, test: TestCommand | null): StopDecision {
  if (state.continueNudges < AGENT_CONTINUE_MAX) {
    if (isCutOff(turn.stopReason)) return { kind: 'continue', note: CONTINUE_CUT_NUDGE };
    if (announcesAction(turn.text)) return { kind: 'continue', note: CONTINUE_NUDGE };
  }
  if (state.changedSinceVerify && test !== null && state.verifyRuns < AGENT_VERIFY_MAX) {
    const f = state.failedTest;
    if (f !== null) return { kind: 'verify_nudge', note: verifyFailedNudge(test.command, f.passed, f.failed, f.errors) };
    return { kind: 'verify', command: test.command };
  }
  return { kind: 'finish' };
}
