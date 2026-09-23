/**
 * AGENT-LOOP-DESIGN §A5, the index side of "this run was a reply": a tool-less agent turn never names a session, never hides the task
 * before it, and the picker's stats count it as a reply rather than as the session's result.
 *
 * The engine decides `answered` with `isReplyOnlyRun` (src/core/agent-run.ts). A tool-less agent turn can also end without a finished
 * step: a transient provider failure before any tool call (the first attempt of the session's automatic retry), or a reply stopped
 * with Esc / Ctrl-C. The index carries no tool-call count, so `foldIndex` flags an AGENT-mode run whose `run:end` has no step and no
 * changed file as a reply too (`FoldedRunRow.reply`). Legacy-mode runs are never flagged, so their folds and picker rows are unchanged.
 */
import type { RunRow } from '../core/types.js';

/** a folded run row; `reply` is set by `foldIndex` on agent-mode runs only (absent everywhere else) */
export interface FoldedRunRow extends RunRow {
  reply?: true;
}

/** true when the run stopped `answered`, or `foldIndex` flagged it as a tool-less agent turn that ended before its first step */
export function isReplyRunRow(r: RunRow): boolean {
  return r.stopReason === 'answered' || ('reply' in r && r.reply === true);
}

/** the fold's rule for `FoldedRunRow.reply`: an ended agent-mode run that stopped `answered`, or with no step and no changed file */
export function foldedAsReply(mode: string | null, row: RunRow, changedFiles: number | null): boolean {
  if (mode !== 'agent' || row.endedAt === null) return false;
  return row.stopReason === 'answered' || (row.steps === 0 && (changedFiles ?? 0) === 0);
}
