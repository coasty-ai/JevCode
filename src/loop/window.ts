/**
 * Recent window (DESIGN.md §6): the last WINDOW_SIZE committed steps, each bounded, fed to
 * both the generator prompt and Jev's `recent`. Pure; the engine replaces its array at the
 * commit point only (§11 state-mutation rule).
 */
import { headTail, clip } from '../core/text.js';
import type { ActionOutcome, Intent, JudgeResult, StepRecord, WindowEntry } from '../core/types.js';
import { summariseAction } from '../provider/actions.js';

export const WINDOW_SIZE = 4;
export const WINDOW_OUTPUT_HEAD = 400;
export const WINDOW_OUTPUT_TAIL = 200;
export const WINDOW_REASON_MAX = 600;
export const WINDOW_MAX_NOTES = 12;
export const WINDOW_MAX_SHOWN = 24;

export interface WindowEntryInput {
  step: number;
  intent: Intent | null;
  action: string;
  outcome: ActionOutcome | null;
  /** full output of the executed action (run: stdout+stderr; read: concatenated views) */
  output: string | null;
  judge: JudgeResult | null;
  completion: number | null;
  shownFiles: string[];
  notes: string[];
  /** error message when a stage failed (§6 stage table) */
  error: string | null;
}

export function buildWindowEntry(input: WindowEntryInput): WindowEntry {
  const entry: WindowEntry = {
    step: input.step,
    intent: input.intent,
    action: input.action,
    outcome: input.outcome?.status ?? null,
    shownFiles: input.shownFiles.slice(0, WINDOW_MAX_SHOWN),
    notes: input.notes.slice(0, WINDOW_MAX_NOTES).map((n) => clip(n, 400)),
  };
  const o = input.outcome;
  if (o) {
    if (o.status === 'blocked' || o.status === 'declined') entry.reason = clip(o.reason, WINDOW_REASON_MAX);
    else if (o.status === 'failed') entry.reason = clip(o.error, WINDOW_REASON_MAX);
    if ((o.status === 'executed' || o.status === 'interrupted') && o.exec?.truncated) entry.truncated = true;
  }
  if (input.error && entry.reason === undefined) entry.reason = clip(input.error, WINDOW_REASON_MAX);
  if (input.judge) entry.judge = input.judge;
  if (typeof input.completion === 'number') entry.completion = input.completion;
  if (input.output !== null && input.output.length > 0) entry.output = headTail(input.output, WINDOW_OUTPUT_HEAD, WINDOW_OUTPUT_TAIL);
  return entry;
}

/** Returns a new array with `entry` appended and only the last WINDOW_SIZE kept. */
export function pushWindow(window: readonly WindowEntry[], entry: WindowEntry): WindowEntry[] {
  const next = [...window, entry];
  return next.length > WINDOW_SIZE ? next.slice(next.length - WINDOW_SIZE) : next;
}

/** Output text of an outcome for the window (run: stdout + stderr; nothing otherwise). */
export function outcomeOutput(outcome: ActionOutcome | null): string | null {
  if (!outcome) return null;
  if ((outcome.status === 'executed' || outcome.status === 'interrupted') && outcome.exec) return joinOutput(outcome.exec.stdout, outcome.exec.stderr);
  return null;
}

export function joinOutput(stdout: string, stderr: string): string {
  if (stderr.length === 0) return stdout;
  if (stdout.length === 0) return stderr;
  return `${stdout}\n[stderr]\n${stderr}`;
}

/** --resume: fold a steps.jsonl record that was never checkpointed into the window (§9). */
export function foldStepRecord(window: readonly WindowEntry[], record: StepRecord): WindowEntry[] {
  const notes: string[] = [];
  if (record.interruptedAt) notes.push(record.interruptedAt.stage === 'judge' ? 'interrupted before judge' : `interrupted during ${record.interruptedAt.stage} (${record.interruptedAt.reason})`);
  if (record.error) notes.push(`unjudged: ${record.error.code}`);
  const entry = buildWindowEntry({
    step: record.step,
    intent: record.intent,
    action: record.proposal ? summariseAction(record.proposal.action) : '(no proposal)',
    outcome: record.outcome,
    output: outcomeOutput(record.outcome),
    judge: record.judge,
    completion: record.completion,
    shownFiles: [...record.contextFiles, ...(record.proposal?.action.kind === 'read' ? record.proposal.action.paths : [])],
    notes,
    error: record.error ? `${record.error.stage}: ${record.error.message}` : null,
  });
  return pushWindow(window, entry);
}
