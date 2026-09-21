/**
 * `/undo` application (TUI-DESIGN §12.4) — wave 2. The restore needs the sandbox (`restoreFromHead`, O5) and the
 * workspace realpaths, so wave 1 exports the typed surface only; every function throws until wave 2 wires it.
 * The pure decision table it applies lives in plan.ts and is complete now.
 */
import type { UndoLogEntry, UndoSkipReason } from '../core/types.js';
import type { UndoPlan } from './plan.js';

/** What apply.ts needs injected: the run directory (images), the workspace root, git facts and a HEAD restorer. */
export interface ApplyUndoDeps {
  runDir: string;
  runId: string;
  /** realpath of the workspace */
  root: string;
  /** `git restore --source=HEAD --worktree -- <paths>` through runGit with the neutralising flags (O5 `restoreFromHead`) */
  restoreFromHead: (paths: readonly string[]) => Promise<{ restored: string[]; failed: { path: string; reason: string }[] }>;
  /** ISO clock for the undoLog entry */
  nowIso: () => string;
  /** answers to the plan's ask rows (path → overwrite); an unanswered ask is kept (declined) */
  answers?: Readonly<Record<string, boolean>>;
}

export interface ApplyUndoResult {
  step: number;
  restored: string[];
  skipped: { path: string; reason: UndoSkipReason; message: string }[];
  /** the seed-carried entry (§15 item 9) */
  entry: UndoLogEntry;
  /** `undo step N: restored …` (§24), for the `[ui]` item */
  summary: string;
  /** `human reverted step N: …` for the next run's seed (§12.4) */
  note: string | null;
}

export const NOT_WIRED = 'not wired in wave 1';

/** TUI-DESIGN §12.4: restore the files of one planned step; wave 2 (needs the sandbox and O5's restoreFromHead). */
export function applyUndo(_plan: UndoPlan, _deps: ApplyUndoDeps): Promise<ApplyUndoResult> {
  throw new Error(NOT_WIRED);
}

/** TUI-DESIGN §12.5: undo steps `last…n` in reverse, stopping at the first refusal; wave 2. */
export function applyRewind(_steps: readonly UndoPlan[], _deps: ApplyUndoDeps): Promise<ApplyUndoResult[]> {
  throw new Error(NOT_WIRED);
}
