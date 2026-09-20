/**
 * Resume loading and the pure fold of un-checkpointed steps (DESIGN.md §9 Resume).
 *
 * `state.json` is the sole truth; `steps.jsonl` may carry rows for steps whose checkpoint
 * never landed (the write for step N is allowed to overlap step N+1, §6). Those rows are
 * folded into the window so the generator sees what actually ran, and `step` advances so the
 * resumed run starts one higher. Plan and spend are deliberately not reconstructed: spend is
 * in the checkpointed meter snapshot; a lost plan update reappears via the next PlanDraft.
 *
 * Nothing here writes: the config owner still has to apply the stopReason gate (complete
 * without --force, un-raised budgets) before the engine commits the resume via
 * `store.updateMeta({ resumes })` and `store.writeState(state)`.
 */
import { clip, headTail } from '../core/text.js';
import type { Action, CheckpointState, RunMeta, StepRecord, StopReason, WindowEntry } from '../core/types.js';
import { createCheckpointStore, type DiskCheckpointStore, type Redactor } from './store.js';
import { resolveRunDir } from './run-id.js';

/** Window bounds mirror loop/window.ts (§6): last 4 steps, output head 400 + tail 200. */
export const WINDOW_SIZE = 4;
export const OUTPUT_HEAD = 400;
export const OUTPUT_TAIL = 200;
export const OUTPUT_MAX = OUTPUT_HEAD + OUTPUT_TAIL;
const REASON_MAX = 600;
const ACTION_MAX = 200;
const NOTE_MAX = 200;
const SHOWN_FILES_MAX = 64;

export const FOLDED_NOTE = 'folded on resume from steps.jsonl (checkpoint for this step was lost)';

export interface ResumeLoad {
  store: DiskCheckpointStore;
  meta: RunMeta;
  /** Resume-ready: folded steps applied, stopReason cleared, resumes incremented. */
  state: CheckpointState;
  recoveredFrom: 'state' | 'prev';
  /** steps.jsonl rows with step > checkpointed step, ascending, last row per step. */
  foldedSteps: StepRecord[];
  /** `state.step` as checkpointed, before folding. */
  checkpointStep: number;
  /** stopReason as checkpointed; the config owner's gate needs it after the fold cleared it. */
  previousStopReason: StopReason | null;
  /** load()/readStepsAfter() warnings, in order (prev fallback, torn lines). */
  warnings: string[];
}

export interface ResumeOptions {
  redact: Redactor;
  /** injectable clock for deterministic `updatedAt` */
  now?: () => Date;
}

export function summariseAction(action: Action): string {
  switch (action.kind) {
    case 'read':
      return clip(`read ${action.paths.join(', ')}`, ACTION_MAX);
    case 'edit':
      return clip(`edit ${action.path}`, ACTION_MAX);
    case 'write':
      return clip(`write ${action.path}`, ACTION_MAX);
    case 'patch':
      return `patch (${action.diff.split('\n').length} lines)`;
    case 'run':
      return clip(`run ${action.command}`, ACTION_MAX);
    case 'done':
      return 'done';
  }
}

/** headTail plus the omission marker can pass 600; shrink the tail until the whole entry fits (§6 window bound). */
export function boundOutput(s: string): string {
  if (s.length <= OUTPUT_MAX) return s;
  let tail = OUTPUT_TAIL;
  for (let i = 0; i < 4 && tail > 0; i++) {
    const out = headTail(s, OUTPUT_HEAD, tail);
    if (out.length <= OUTPUT_MAX) return out;
    tail -= out.length - OUTPUT_MAX;
  }
  return clip(s, OUTPUT_MAX);
}

function uniqueBounded(items: readonly string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The window entry a committed StepRecord implies, from the record alone. Small and
 * deterministic so the engine's window and the resume fold agree on what a lost step looked like.
 */
export function makeWindowEntryFromRecord(r: StepRecord): WindowEntry {
  const action = r.proposal ? summariseAction(r.proposal.action) : r.error ? `(no proposal: ${r.error.stage} failed)` : '(no proposal)';
  const readPaths = r.proposal?.action.kind === 'read' ? r.proposal.action.paths : [];
  const entry: WindowEntry = {
    step: r.step,
    intent: r.intent,
    action,
    outcome: r.outcome ? r.outcome.status : null,
    shownFiles: uniqueBounded([...r.contextFiles, ...readPaths], SHOWN_FILES_MAX),
    notes: [],
  };
  const o = r.outcome;
  if (o) {
    if (o.status === 'blocked' || o.status === 'declined') entry.reason = clip(o.reason, REASON_MAX);
    if (o.status === 'failed') entry.reason = clip(o.error, REASON_MAX);
    const exec = o.status === 'executed' || o.status === 'interrupted' ? o.exec : undefined;
    if (exec) {
      const combined = exec.stderr.length > 0 ? `${exec.stdout}\n${exec.stderr}` : exec.stdout;
      if (combined.length > 0) entry.output = boundOutput(combined);
      if (exec.truncated) entry.truncated = true;
      if (exec.exitCode !== null && exec.exitCode !== 0) entry.notes.push(`exit ${exec.exitCode}`);
      // §6: a wall-time kill must read as a budget stop, never as a slow command, so a resumed
      // run does not treat the command as one that times out.
      if (exec.killedBy === 'wall_time') entry.notes.push('stopped by wall-time budget');
      else if (exec.killedBy === 'timeout') entry.notes.push('command timed out');
      else if (exec.killedBy === 'abort') entry.notes.push('killed by abort');
    } else if (o.status === 'executed' || o.status === 'noop') {
      if (o.summary.length > 0) entry.output = boundOutput(o.summary);
    }
    if (o.status === 'executed' && o.changedFiles.length > 0) {
      entry.notes.push(clip(`changed: ${o.changedFiles.join(', ')}`, NOTE_MAX));
    }
  }
  if (r.judge) entry.judge = r.judge;
  if (r.completion !== null) entry.completion = r.completion;
  if (r.interruptedAt) {
    // §9.1 rule 3 wording; rule 2 (execute) names the stage so the generator knows the command was cut
    entry.notes.push(r.interruptedAt.stage === 'judge' ? 'interrupted before judge' : `interrupted during ${r.interruptedAt.stage} (${r.interruptedAt.reason})`);
  }
  if (r.error) {
    entry.notes.push(r.error.stage === 'judge' ? `unjudged: ${r.error.code}` : clip(`${r.error.stage} failed: ${r.error.code}`, NOTE_MAX));
  }
  return entry;
}

/**
 * Pure §9 fold: rows with step > state.step enter the window (bounded), `step` advances to
 * the highest folded step, stopReason/error clear, resumes increments. Input is not mutated.
 */
export function foldStepsIntoState(state: CheckpointState, steps: readonly StepRecord[], updatedAt: string = new Date().toISOString()): CheckpointState {
  const byStep = new Map<number, StepRecord>();
  for (const r of steps) {
    if (!Number.isInteger(r.step) || r.step <= state.step) continue;
    byStep.set(r.step, r);
  }
  const folded = [...byStep.values()].sort((a, b) => a.step - b.step);

  let window = [...state.window];
  let step = state.step;
  let lastChangeStep = state.lastChangeStep;
  for (const r of folded) {
    const entry = makeWindowEntryFromRecord(r);
    entry.notes = [...entry.notes, FOLDED_NOTE];
    window = [...window, entry].slice(-WINDOW_SIZE);
    step = r.step;
    // A folded step that changed files must invalidate `testsCurrent` (§5.5 derives it from
    // lastChangeStep); leaving it stale would tell Jev the tests still cover the tree.
    if (r.outcome?.status === 'executed' && r.outcome.changedFiles.length > 0) lastChangeStep = r.step;
  }

  // A rule-1 diagnostic is stale once a committed row exists at or past its step number.
  const interrupted = state.interrupted && step >= state.interrupted.step ? null : state.interrupted;

  const { error: _droppedError, ...rest } = state;
  void _droppedError;
  return {
    ...rest,
    step,
    window,
    lastChangeStep,
    interrupted,
    stopReason: null,
    resumes: state.resumes + 1,
    updatedAt,
  };
}

/** Validate the id, open the store, load the truth, fold the steps.jsonl tail. Read-only. */
export async function loadForResume(runsDir: string, runId: string, opts: ResumeOptions): Promise<ResumeLoad> {
  const runDir = await resolveRunDir(runsDir, runId);
  const store = createCheckpointStore(runDir, opts.redact);
  const loaded = await store.load();
  const warnings = [...store.lastWarnings()];
  const foldedSteps = await store.readStepsAfter(loaded.state.step);
  warnings.push(...store.lastWarnings());
  const now = opts.now ?? (() => new Date());
  const state = foldStepsIntoState(loaded.state, foldedSteps, now().toISOString());
  return {
    store,
    meta: loaded.meta,
    state,
    recoveredFrom: loaded.recoveredFrom,
    foldedSteps,
    checkpointStep: loaded.state.step,
    previousStopReason: loaded.state.stopReason,
    warnings,
  };
}
