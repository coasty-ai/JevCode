/**
 * Follow-up seeding (TUI-DESIGN §8.3, A52, 10 §15.2; pure). A follow-up is a new run whose plan, window, created
 * files, last test run and undo log come from the parent; the parent's framing, the human's notes (`/undo`, `/rewind`)
 * and the parent's still-pending steers become step-0 `human` harness problems, which `applyPendingDirectives` (§8.6)
 * never supersedes (only steer problems, `step > 0`, are). No I/O, no clock: everything is a function of its inputs.
 */
import { clip } from '../core/text.js';
import type { CheckpointState, EngineSeed, HarnessProblem, Plan, PlanSnapshot, RunMeta, WindowEntry } from '../core/types.js';

/** TUI-DESIGN §8.3: the parent's last 4 window entries are carried. */
export const SEED_WINDOW_ENTRIES = 4;
/** TUI-DESIGN §8.3: `notes` per window entry after the `from run <id>` note. */
export const SEED_MAX_NOTES = 12;
/** TUI-DESIGN §8.3: a human note or carried steer is clipped at 600 chars, the parent task at 200. */
export const SEED_NOTE_CHARS = 600;
export const SEED_TASK_CHARS = 200;

export interface SeedParent {
  meta: RunMeta;
  /** null for a run that never reached a checkpoint (config / 401 at step 0): it contributes nothing but is still the parent */
  state: CheckpointState | null;
}

export interface SeedOptions {
  /** `human reverted step 7: …`, `/rewind plan+window to step N` */
  humanNotes: readonly string[];
  /** @-mentions from the composer */
  pinnedFiles: readonly string[];
  /** `/rewind N plan+window`: seed from the step's committed `planAfter` and the window up to that step */
  rewind?: { step: number; planAfter: PlanSnapshot | null };
}

const EMPTY_PLAN: Plan = { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] };

/** TUI-DESIGN §8.3: the step-0 framing problem every seeded run carries. */
export function seedFramingText(parent: SeedParent): string {
  const stopped = parent.state?.stopReason ?? 'in progress';
  return `Follow-up to run ${parent.meta.runId} (stopped: ${stopped}) whose task was "${clip(parent.meta.task, SEED_TASK_CHARS)}"; the task above is the human's next instruction`;
}

/**
 * TUI-DESIGN §8.3 `buildSeed`: plan done/remaining/unverified from the parent (or the rewound step's `planAfter`),
 * `openProblems: []` (generator-owned), `harnessProblems` = framing + human notes + the parent's pending steers (all
 * `step: 0`); window = last 4 (up to the rewound step) with `from run <id>` appended to each entry's notes (≤ 12);
 * `createdThisRun`, `lastTestRun`, `undoLog` and `pinnedFiles` carried.
 */
export function buildSeed(parent: SeedParent, opts: SeedOptions): EngineSeed {
  const state = parent.state;
  const src: Pick<Plan, 'done' | 'remaining' | 'unverified'> = opts.rewind?.planAfter ?? state?.plan ?? EMPTY_PLAN;
  const human = (text: string): HarnessProblem => ({ kind: 'human', step: 0, text: clip(text, SEED_NOTE_CHARS) });
  const plan: Plan = {
    done: src.done.map((d) => ({ ...d })),
    remaining: [...src.remaining],
    unverified: src.unverified.map((u) => ({ ...u })),
    openProblems: [],
    harnessProblems: [
      { kind: 'human', step: 0, text: seedFramingText(parent) },
      ...opts.humanNotes.filter((t) => t.trim() !== '').map(human),
      ...(state?.pendingDirectives ?? []).filter((d) => d.text.trim() !== '').map((d) => human(d.text)),
    ],
  };
  const source: readonly WindowEntry[] = state?.window ?? [];
  const rewind = opts.rewind;
  const window: WindowEntry[] = (rewind ? source.filter((e) => e.step <= rewind.step) : source)
    .slice(-SEED_WINDOW_ENTRIES)
    .map((e) => ({ ...e, notes: [...e.notes, `from run ${parent.meta.runId}`].slice(0, SEED_MAX_NOTES) }));
  return {
    parentRunId: parent.meta.runId,
    plan,
    window,
    createdThisRun: [...(state?.createdThisRun ?? [])],
    lastTestRun: state?.lastTestRun ? { ...state.lastTestRun } : null,
    undoLog: [...(state?.undoLog ?? [])],
    pinnedFiles: [...opts.pinnedFiles],
  };
}

/** Number of steers carried from the parent's `pendingDirectives` (for the `· N pending steer carried` suffix). */
export function carriedSteers(parent: SeedParent): number {
  return (parent.state?.pendingDirectives ?? []).filter((d) => d.text.trim() !== '').length;
}

/**
 * TUI-DESIGN §8.3 / §8.4: a run's last activity — the latest of its checkpoint's `updatedAt`, its `resumes[].resumedAt`
 * and `createdAt` (unparsable stamps ignored; -Infinity when none parses). The picker sorts "by updated" on the same
 * notion, so an older run that was resumed and finished last is the most recent one. Pure.
 */
export function lastActivityMs(run: SeedParent): number {
  const stamps = [run.meta.createdAt, ...run.meta.resumes.map((r) => r.resumedAt), ...(run.state ? [run.state.updatedAt] : [])];
  let best = Number.NEGATIVE_INFINITY;
  for (const t of stamps) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best;
}

/**
 * TUI-DESIGN §8.3 seed-source rule (sessions graft): the most recent run of the session with `state.step > 0`, else
 * the most recent run — a run stopped at step 0 (config / 401) contributes nothing but is still the `parentRunId`.
 * Recency is `lastActivityMs` (ties: array order, later wins). Null for an empty list.
 */
export function seedSource(runs: readonly SeedParent[]): SeedParent | null {
  if (runs.length === 0) return null;
  const byRecency = runs
    .map((r, i) => ({ r, i, at: lastActivityMs(r) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.i - a.i));
  const withSteps = byRecency.find((x) => (x.r.state?.step ?? 0) > 0);
  return (withSteps ?? byRecency[0]!).r;
}

/**
 * TUI-DESIGN §8.3 / §24 transcript line for the engine's `notice kind:'seeded'`, the glossary template verbatim (no
 * pluralisation, so every twin agrees for N = 1):
 * `seeded from run <id>: plan done=4 remaining=2 unverified=1 · window N entries · M created files` + ` · K pending steer carried`.
 */
export function seedNoticeText(seed: EngineSeed, carried: number): string {
  const base = `seeded from run ${seed.parentRunId}: plan done=${seed.plan.done.length} remaining=${seed.plan.remaining.length} unverified=${seed.plan.unverified.length} · window ${seed.window.length} entries · ${seed.createdThisRun.length} created files`;
  return Number.isFinite(carried) && carried > 0 ? `${base} · ${Math.floor(carried)} pending steer carried` : base;
}
