/**
 * `/undo [n]` decision table and `/rewind [step]` planning (TUI-DESIGN §12.4, §12.5, D8) — pure.
 *
 * `planUndo` is a function of the step's post image, the current file facts (lstat + sha256, gathered by the
 * caller), the later steps' post images and the current HEAD oid. It never touches the disk: apply.ts (wave 2)
 * performs every check here before its first write. Every user-facing string is the §24 text.
 */
import type { PlanSnapshot, UndoLogEntry, UndoSkipReason } from '../core/types.js';
import type { PostImage, PostImageFile } from '../checkpoint/images.js';
import { truncateRightCells } from './diff.js';

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

/** What the caller learnt about one path right before planning (lstat, sha256, realpath, git status). */
export interface CurrentFileState {
  /** lstat succeeded (any file type) */
  exists: boolean;
  /** sha256 of the current bytes; null when missing, not a regular file, or too large to hash */
  sha256: string | null;
  /** lstat().isSymbolicLink() */
  symlink?: boolean;
  /** lstat().nlink */
  nlink?: number;
  /** the realpath resolves outside <ws> or into .git */
  escapes?: boolean;
  /** git status `sub[0] === 'S'` */
  submodule?: boolean;
}

export interface UndoPlanInput {
  /** the step being undone (N) */
  step: number;
  post: PostImage;
  /** per path in post.files; a missing key reads as `{ exists: false, sha256: null }` */
  current: Readonly<Record<string, CurrentFileState>>;
  /** post images of committed, not-undone steps M > N */
  later: readonly PostImage[];
  /** the current HEAD oid (null: unborn or no repository) */
  headOid: string | null;
  /** the workspace is a git repository */
  git: boolean;
}

/** How a restore would be performed, in the §12.4 source order. */
export type RestoreVia = 'pre-image' | 'unlink' | 'git-restore';

export type UndoDecision =
  | { kind: 'restore'; path: string; via: RestoreVia }
  | { kind: 'ask'; path: string; via: RestoreVia; prompt: string }
  | { kind: 'refuse'; path: string; laterStep: number; message: string }
  | { kind: 'skip'; path: string; reason: UndoSkipReason; message: string };

export interface UndoPlan {
  step: number;
  /** one per path in post.files, in the post image's order */
  decisions: UndoDecision[];
  /** refusals block the whole undo: apply.ts writes nothing while this is non-empty (§12.4 "all checks before the first write") */
  refusals: Extract<UndoDecision, { kind: 'refuse' }>[];
  /** paths that need a y/N answer before the first write */
  asks: Extract<UndoDecision, { kind: 'ask' }>[];
}

// ---------------------------------------------------------------------------------------
// §24 strings
// ---------------------------------------------------------------------------------------

export const NOT_RECOVERABLE_COMMAND = 'not recoverable — changed by a command, not tracked by git';
export const NOT_RECOVERABLE_NO_GIT = 'not recoverable — no git repository';
/** The pre-image was skipped for size (> 1 MiB, TUI-DESIGN §12.3) — the contract's `UndoSkipReason 'size'`; §24 names no text, this is the one twin. */
export const NOT_RECOVERABLE_SIZE = 'not recoverable — no pre-image (file > 1 MiB)';
/** The pre-image was skipped by the 200-file / 16 MiB copy cap (TUI-DESIGN §12.3) — `UndoSkipReason 'cap'`. */
export const NOT_RECOVERABLE_CAP = 'not recoverable — no pre-image (copy cap reached)';
export const UNDO_ASK_TAIL = 'Overwrite? [y/N]  a=all  s=skip rest  Esc=abort';

/** `not recoverable — HEAD moved since step N` (TUI-DESIGN §12.4, new rule E10). */
export function headMovedMessage(step: number): string {
  return `not recoverable — HEAD moved since step ${step}`;
}

/** `<path> was changed again by step M; use /rewind N to undo steps N–M together` (TUI-DESIGN §12.4 row 3). */
export function refuseMessage(path: string, step: number, laterStep: number): string {
  return `${path} was changed again by step ${laterStep}; use /rewind ${step} to undo steps ${step}–${laterStep} together`;
}

/** `<path> changed since step N (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort` (TUI-DESIGN §12.4 row 4, §24). */
export function askPrompt(path: string, step: number): string {
  return `${path} changed since step ${step} (outside JevCode). ${UNDO_ASK_TAIL}`;
}

// ---------------------------------------------------------------------------------------
// planUndo
// ---------------------------------------------------------------------------------------

const MISSING: CurrentFileState = { exists: false, sha256: null };

/** The pre-image skip recorded for `path` by writePreImages (size / cap), if any (TUI-DESIGN §12.3 `skipped`). */
function preImageSkip(path: string, post: PostImage): 'size' | 'cap' | null {
  for (const s of post.skipped) if (s.path === path && (s.reason === 'size' || s.reason === 'cap')) return s.reason;
  return null;
}

/**
 * §12.4 restore source order: pre-image → unlink (created, no pre-image) → git restore from an unchanged HEAD
 * (`run`, clean at start) → not recoverable, explained: a pre-image skipped for size / cap (§12.3), no git
 * repository, HEAD moved (E10), or changed by a command.
 */
function resolveVia(path: string, file: PostImageFile, input: UndoPlanInput): { via: RestoreVia } | { skip: UndoSkipReason; message: string } {
  if (file.preImage === true) return { via: 'pre-image' };
  if (file.created === true) return { via: 'unlink' };
  const fromHead = input.git && file.source === 'run' && file.cleanAtStart === true;
  // E10: `git restore --source=HEAD` only restores the state the step saw when HEAD is the same commit
  if (fromHead && input.post.headOid !== null && input.headOid === input.post.headOid) return { via: 'git-restore' };
  const skipped = preImageSkip(path, input.post);
  if (skipped === 'size') return { skip: 'size', message: NOT_RECOVERABLE_SIZE };
  if (skipped === 'cap') return { skip: 'cap', message: NOT_RECOVERABLE_CAP };
  if (!input.git) return { skip: 'not-recoverable', message: NOT_RECOVERABLE_NO_GIT };
  if (fromHead && input.post.headOid !== null) return { skip: 'head-moved', message: headMovedMessage(input.step) };
  return { skip: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND };
}

/** The latest later step whose recorded state of `path` equals what is on disk now (row 3). */
function laterStepMatching(path: string, cur: CurrentFileState, input: UndoPlanInput): number | null {
  let best: number | null = null;
  for (const m of input.later) {
    if (m.step <= input.step) continue;
    const f = m.files[path];
    if (f === undefined) continue;
    const matches = cur.exists ? cur.sha256 !== null && f.sha256 === cur.sha256 : f.deleted === true;
    if (matches && (best === null || m.step > best)) best = m.step;
  }
  return best;
}

function decide(path: string, file: PostImageFile, input: UndoPlanInput): UndoDecision {
  const cur = input.current[path] ?? MISSING;
  // safety rows first: never write through a link, outside the tree, or into a submodule
  if (cur.symlink === true || (cur.nlink !== undefined && cur.nlink > 1)) return { kind: 'skip', path, reason: 'link', message: 'symlink or hard link' };
  if (cur.escapes === true) return { kind: 'skip', path, reason: 'escape', message: 'resolves outside the workspace or into .git' };
  if (cur.submodule === true) return { kind: 'skip', path, reason: 'submodule', message: 'submodule' };
  const via = resolveVia(path, file, input);
  if ('skip' in via) return { kind: 'skip', path, reason: via.skip, message: via.message };
  // comparison rows
  const unchanged = file.deleted === true ? !cur.exists : cur.exists && file.sha256 !== null && file.sha256 !== undefined && cur.sha256 === file.sha256;
  if (unchanged) return { kind: 'restore', path, via: via.via };
  const later = laterStepMatching(path, cur, input);
  if (later !== null) return { kind: 'refuse', path, laterStep: later, message: refuseMessage(path, input.step, later) };
  return { kind: 'ask', path, via: via.via, prompt: askPrompt(path, input.step) };
}

/**
 * TUI-DESIGN §12.4: the decision table over one step's post image. Rows in evaluation order: link / escape /
 * submodule skips, the restore-source resolution (incl. the HEAD-moved rule and the size / cap pre-image skips),
 * then sha256 equal → restore, missing + deleted → restore, differs + a later step recorded the current state →
 * refuse, differs → ask. `sha256: null` (hashing budget exhausted, §12.3) is an "ask" row. Pure: the input is
 * never mutated and equal inputs give equal plans.
 */
export function planUndo(input: UndoPlanInput): UndoPlan {
  const decisions: UndoDecision[] = [];
  for (const [path, file] of Object.entries(input.post.files)) decisions.push(decide(path, file, input));
  return {
    step: input.step,
    decisions,
    refusals: decisions.filter((d): d is Extract<UndoDecision, { kind: 'refuse' }> => d.kind === 'refuse'),
    asks: decisions.filter((d): d is Extract<UndoDecision, { kind: 'ask' }> => d.kind === 'ask'),
  };
}

// ---------------------------------------------------------------------------------------
// The one-row `undo` overlay (y/N · a=all · s=skip rest · Esc=abort; Enter = n)
// ---------------------------------------------------------------------------------------

export type UndoAskKey = 'y' | 'n' | 'a' | 's' | 'esc' | 'enter';

export interface UndoAskState {
  plan: UndoPlan;
  /** index into plan.asks of the row being shown; === plan.asks.length when done */
  index: number;
  /** answered asks: true = overwrite */
  answers: Readonly<Record<string, boolean>>;
  aborted: boolean;
}

/** TUI-DESIGN §12.4: start the ask sequence; `done` at once when the plan has no ask rows. */
export function startUndoAsks(plan: UndoPlan): UndoAskState {
  return { plan, index: 0, answers: {}, aborted: false };
}

/** TUI-DESIGN §12.4: the ask row on screen, or null when the sequence is finished or aborted. */
export function currentAsk(state: UndoAskState): Extract<UndoDecision, { kind: 'ask' }> | null {
  if (state.aborted) return null;
  return state.plan.asks[state.index] ?? null;
}

/** TUI-DESIGN §12.4: every ask answered (or the sequence aborted). */
export function undoAsksDone(state: UndoAskState): boolean {
  return state.aborted || state.index >= state.plan.asks.length;
}

/**
 * TUI-DESIGN §12.4 / §24: `y` overwrites this file, `n` / Enter keeps it (default n), `a` overwrites this and
 * every remaining file, `s` keeps every remaining file, Esc aborts the whole undo. Pure; keys after `done` are inert.
 */
export function reduceUndoAsk(state: UndoAskState, key: UndoAskKey): UndoAskState {
  if (undoAsksDone(state)) return state;
  const rest = state.plan.asks.slice(state.index);
  const answers: Record<string, boolean> = { ...state.answers };
  switch (key) {
    case 'esc':
      return { ...state, aborted: true };
    case 'a':
      for (const a of rest) answers[a.path] = true;
      return { ...state, answers, index: state.plan.asks.length };
    case 's':
      for (const a of rest) answers[a.path] = false;
      return { ...state, answers, index: state.plan.asks.length };
    case 'y':
    case 'n':
    case 'enter': {
      const cur = rest[0];
      if (cur === undefined) return state;
      answers[cur.path] = key === 'y';
      return { ...state, answers, index: state.index + 1 };
    }
  }
}

/** TUI-DESIGN §12.4: the plan with every answered ask turned into `restore` (y) or `skip declined` (n); unanswered asks stay asks. */
export function resolveAsks(plan: UndoPlan, answers: Readonly<Record<string, boolean>>): UndoDecision[] {
  return plan.decisions.map((d) => {
    if (d.kind !== 'ask') return d;
    const a = answers[d.path];
    if (a === undefined) return d;
    return a ? { kind: 'restore', path: d.path, via: d.via } : { kind: 'skip', path: d.path, reason: 'declined', message: 'kept (declined)' };
  });
}

/** A skipped file as the summary line and the `undoLog` entry record it (TUI-DESIGN §12.4, §15 item 9). */
export interface UndoSkip {
  path: string;
  reason: UndoSkipReason;
  message: string;
}

/**
 * TUI-DESIGN §12.4 / §15 item 9: the files a plan does not restore, with the contract's `UndoSkipReason` — a
 * `refuse` row is `refused` (its /rewind hint is the message), an unanswered `ask` is `declined` (default n),
 * a `skip` keeps its reason. `restore` rows are not skips.
 */
export function skipsFromDecisions(decisions: readonly UndoDecision[]): UndoSkip[] {
  const out: UndoSkip[] = [];
  for (const d of decisions) {
    if (d.kind === 'refuse') out.push({ path: d.path, reason: 'refused', message: d.message });
    else if (d.kind === 'ask') out.push({ path: d.path, reason: 'declined', message: 'kept (declined)' });
    else if (d.kind === 'skip') out.push({ path: d.path, reason: d.reason, message: d.message });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Output strings (§12.4, §24)
// ---------------------------------------------------------------------------------------

/** Paths listed in transcript lines: at most this many names, then `… N more`. */
export const UNDO_LIST_MAX = 10;

function pathList(paths: readonly string[]): string {
  if (paths.length <= UNDO_LIST_MAX) return paths.join(', ');
  return `${paths.slice(0, UNDO_LIST_MAX).join(', ')}, … ${paths.length - UNDO_LIST_MAX} more`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * `undo step 7: restored 3 files (src/a.py, src/b.py), skipped 1 (build/out.txt: not recoverable — …)` /
 * `no files restored (…)` (TUI-DESIGN §12.4; the `[ui]` label is the item's). Pure.
 */
export function undoSummaryLine(step: number, restored: readonly string[], skipped: readonly { path: string; reason: UndoSkipReason; message?: string }[]): string {
  const skippedText = skipped.map((s) => `${s.path}: ${s.message ?? s.reason}`);
  if (restored.length === 0) {
    return `no files restored${skippedText.length > 0 ? ` (${pathList(skippedText)})` : ` (step ${step} changed no files)`}`;
  }
  const head = `undo step ${step}: restored ${plural(restored.length, 'file')} (${pathList(restored)})`;
  return skipped.length === 0 ? head : `${head}, skipped ${skipped.length} (${pathList(skippedText)})`;
}

/** `human reverted step 7: src/a.py, src/b.py, tests/test_a.py` — the next run's seed note (TUI-DESIGN §12.4). */
export function undoNote(step: number, restored: readonly string[]): string {
  return `human reverted step ${step}: ${pathList(restored)}`;
}

/** The `undoLog` entry carried by the next run's seed (TUI-DESIGN §15 item 9). */
export function undoLogEntry(input: {
  runId: string;
  step: number;
  at: string;
  by: 'undo' | 'rewind';
  restored: readonly string[];
  skipped: readonly { path: string; reason: UndoSkipReason }[];
}): UndoLogEntry {
  return { runId: input.runId, step: input.step, at: input.at, by: input.by, restored: [...input.restored], skipped: input.skipped.map((s) => ({ path: s.path, reason: s.reason })) };
}

// ---------------------------------------------------------------------------------------
// /rewind [step] (TUI-DESIGN §12.5)
// ---------------------------------------------------------------------------------------

export interface RewindStep {
  step: number;
  /** from the reducer's step:end records (outcome.changedFiles) */
  changedFiles: readonly string[];
  planAfter?: PlanSnapshot;
}

export interface RewindPlan {
  target: number;
  /** steps to undo, last first, stopping at the first refusal (apply.ts) */
  order: number[];
  /** the step whose `planAfter` seeds the next run; null → the parent's final plan with a notice */
  planAfterFrom: number | null;
  /** window entries with step ≤ this survive (§8.3) */
  windowUpTo: number;
}

export const REWIND_RULE = '─── rewind · steps with changes ─ ↑↓ Enter Esc ───';
export const REWIND_CHOICE = 'files (done) · [p] plan+window · [b] both · Esc keep';
export const REWIND_PLAN_FALLBACK_NOTICE = 'no plan snapshot for that step; the next run seeds from the final plan';

/**
 * TUI-DESIGN §12.5: undo steps `last…n` in reverse (only steps with changed files need an undo); the plan of
 * step n (`planAfter`, when the step recorded one, else the parent's final plan) seeds the next run; window ≤ n.
 */
export function planRewind(steps: readonly RewindStep[], target: number): RewindPlan {
  const n = Number.isInteger(target) && target >= 1 ? target : 1;
  const order = steps
    .filter((s) => s.step >= n && s.changedFiles.length > 0)
    .map((s) => s.step)
    .sort((a, b) => b - a);
  const at = steps.find((s) => s.step === n);
  return { target: n, order, planAfterFrom: at?.planAfter ? n : null, windowUpTo: n };
}

/** Steps that appear in the rewind picker: committed steps with changed files, oldest first (TUI-DESIGN §12.5). */
export function rewindCandidates(steps: readonly RewindStep[]): RewindStep[] {
  return steps.filter((s) => s.changedFiles.length > 0).sort((a, b) => a.step - b.step);
}

/**
 * TUI-DESIGN §12.5 / §24 rule row: picker rows for the pane slot, `s7   3 files  src/a.py, src/b.py, tests/test_a.py`
 * cut to `columns` cells with `…` (§2.1: by the pure function, never by Ink). Pure; the caller marks the selected row.
 */
export function rewindPickerRows(steps: readonly RewindStep[], columns: number): string[] {
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  return rewindCandidates(steps).map((s) => truncateRightCells(`s${s.step}   ${plural(s.changedFiles.length, 'file')}  ${pathList(s.changedFiles)}`, cols));
}
