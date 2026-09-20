/**
 * Replan directives and stale-site detection (docs/JEV-ONLY-DESIGN.md §5.3, §5.4).
 *
 * When the engine's loop detector trips, its replan stage hands the synthesizer a directive
 * (`ctx.directive`, the text of `loop/stages/replan.ts directiveText`). The mapping is code:
 *
 * - `change_approach`  → rotate the active goal's source order (its exhausted set is kept),
 *                        widen the site beam 6 → 10 and, on repositories, allow the WIDENED
 *                        phase over the beam functions; the step then searches as usual. With
 *                        every goal parked, every parked goal is reopened (ledger order), each
 *                        with its source order rotated and its sites rebuilt.
 * - `gather_context`   → on a repository, `read` the goal's suspected files the context stage
 *                        has not shown; otherwise re-localise with the latest failure text and a
 *                        top-10 file beam.
 * - `fix_environment`  → a `run` of the test command alone. The synthesizer installs nothing;
 *                        the outcome tells the judge whether the environment works.
 * - `revert_changes`   → reverse `patch` of the last committed candidate; the goal it fixed
 *                        returns to `remaining`; the baseline is dropped so the next step
 *                        re-runs the suite and re-derives the ledger from the real workspace.
 * - `stop_and_report`  → never reaches the synthesizer (the engine stops on `replan_stop`).
 *
 * A `patch` whose outcome was `failed` (did not apply) means the goal's sites are stale: the
 * localisation cache for that goal is invalidated and the next search re-localises from the
 * re-read file (§5.3).
 */
import type { Proposal, SynthesisContext } from '../../core/types.js';
import type { AppliedCandidate, LocalizeResult, TestRunSummary } from '../types.js';
import { TEST_PATH_RE, diffPaths, engineTestCommand, proposeRead, proposeRevert, proposeRun, type ProposalMemory } from './proposal.js';
import type { Goal } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/** The §2.5 site cut: ≤ 6 replace + ≤ 6 insert sites per goal. */
export const DEFAULT_SITE_BEAM = 6;
/**
 * The widened cut under `change_approach`. Q5's misses sit at true-line rank 6 (`lis`, `mergesort`
 * at p 0.02–0.03, experiments/results/prototype-baseline.md), so a beam of 10 reaches them.
 */
export const WIDENED_SITE_BEAM = 10;
/** The §2.5 repository file beam (Q2/Q3 top-5: gold ≤ 5 on 28/30, probe-swebench-understanding.md). */
export const DEFAULT_FILE_BEAM = 5;
/** Under `gather_context`: gold in the top-10 on 30/30 instances (probe-swebench-understanding.md §Q6). */
export const WIDENED_FILE_BEAM = 10;

export type DirectiveMove = 'change_approach' | 'gather_context' | 'fix_environment' | 'revert_changes';
const MOVES: readonly DirectiveMove[] = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes'];
/**
 * The engine's fallback directive ("no listed recovery applicable … propose a different action")
 * maps to `change_approach`, the replan stage's own fallback move (REPLAN_FALLBACK).
 */
export const FALLBACK_MOVE: DirectiveMove = 'change_approach';

export class DirectiveError extends Error {
  constructor(message: string) {
    super(`DirectiveError: ${message}`);
    this.name = 'DirectiveError';
  }
}

// ---------------------------------------------------------------------------------------
// Memory the directives adjust (structural subset of SearchMemory, §2.1)
// ---------------------------------------------------------------------------------------

/** Search knobs a directive turns; read by subgoal.ts (`orderSources`) and sites.ts (`buildGoalSites`). */
export interface SearchOverrides {
  /** goalId → how many times the default source order was rotated left (exhausted sets untouched) */
  sourceRotation: Record<string, number>;
  /** replace and insert sites per goal (§2.5 cut) */
  siteBeam: number;
  /** WIDENED phase allowed on repository workspaces (single files always may) */
  widenedOnRepos: boolean;
  /** Q2/Q3 file beam for re-localisation */
  fileBeam: number;
}

export function defaultOverrides(): SearchOverrides {
  return { sourceRotation: {}, siteBeam: DEFAULT_SITE_BEAM, widenedOnRepos: false, fileBeam: DEFAULT_FILE_BEAM };
}

/** The slice of `SearchMemory` the directives read and mutate. */
export interface DirectiveMemory extends ProposalMemory {
  baseline: TestRunSummary | null;
  goals: Goal[];
  committed: AppliedCandidate[];
  /** per goal id; invalidated when the goal's sites may be stale */
  localizeCache: Map<string, LocalizeResult>;
  overrides: SearchOverrides;
}

export type DirectiveResult =
  /** the directive produced this step's proposal */
  | { kind: 'proposal'; move: DirectiveMove; proposal: Proposal; changes: string[] }
  /** memory was adjusted; the step continues with the normal search */
  | { kind: 'continue'; move: DirectiveMove; changes: string[] };

// ---------------------------------------------------------------------------------------
// Parsing and workspace shape
// ---------------------------------------------------------------------------------------

/**
 * The move named in a directive text (`` `change_approach` `` … as `directiveText` writes it).
 * Null when there is no directive; the engine's fallback wording maps to FALLBACK_MOVE.
 */
export function parseDirective(text: string | null): DirectiveMove | null {
  if (text === null || text.trim().length === 0) return null;
  for (const move of MOVES) if (new RegExp(`\`${move}\``).test(text) || new RegExp(`\\b${move}\\b`).test(text)) return move;
  return FALLBACK_MOVE;
}

/**
 * A repository workspace has more than one non-test Python file. The single-file shortcut of
 * §2.5 and the WIDENED rule of §2.3 hinge on this, not on `git` (QuixBugs bench workspaces are
 * git-initialised too).
 */
export async function isRepositoryWorkspace(ctx: SynthesisContext): Promise<boolean> {
  const listed = await ctx.workspace.listCandidates();
  let sources = 0;
  for (const c of listed) if (c.path.endsWith('.py') && !TEST_PATH_RE.test(c.path)) sources += 1;
  return sources > 1;
}

/** The goal the search is on: `active`, else the first `open`, else null. */
export function activeGoal(mem: DirectiveMemory): Goal | null {
  return mem.goals.find((g) => g.status === 'active') ?? mem.goals.find((g) => g.status === 'open') ?? null;
}

// ---------------------------------------------------------------------------------------
// The directive handler
// ---------------------------------------------------------------------------------------

function emit(ctx: SynthesisContext, move: DirectiveMove, changes: readonly string[]): void {
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'directive', detail: `${move}: ${changes.length > 0 ? changes.join('; ') : 'nothing to change'}` });
}

/** Which committed goal a revert reopens: the fixed goal whose suspected files the commit touched, else the last fixed goal. */
export function goalForCommit(mem: DirectiveMemory, applied: AppliedCandidate): Goal | null {
  const touched = new Set([...applied.files.map((f) => f.path), ...diffPaths(applied.diff)]);
  const fixed = mem.goals.filter((g) => g.status === 'fixed');
  const byFile = fixed.filter((g) => g.suspectedFiles.some((p) => touched.has(p)));
  if (byFile.length === 1) return byFile[0]!;
  return byFile.at(-1) ?? fixed.at(-1) ?? null;
}

export interface DirectiveOptions {
  /** timeout of the `fix_environment` run (the oracle's `runTimeoutMs`, budget.ts); the engine's default when absent */
  runTimeoutMs?: number;
}

/**
 * Apply `ctx.directive` per §5.4. Throws DirectiveError when there is no directive (the caller
 * checks `ctx.directive` first, §2.2). Returns either the step's proposal or `continue` after
 * adjusting memory.
 */
export async function handleDirective(ctx: SynthesisContext, mem: DirectiveMemory, opts: DirectiveOptions = {}): Promise<DirectiveResult> {
  const move = parseDirective(ctx.directive);
  if (move === null) throw new DirectiveError('handleDirective called without a directive');
  const changes: string[] = [];
  const done = (result: DirectiveResult): DirectiveResult => {
    emit(ctx, move, result.changes);
    return result;
  };

  switch (move) {
    case 'change_approach': {
      const active = activeGoal(mem);
      const targets: Goal[] = active === null ? [] : [active];
      if (active === null) {
        // Every goal parked: the directive is the one occasion to give EVERY parked goal another
        // go, in ledger order. Reopening only the newest (`.at(-1)`) left ladder `account`'s g1 —
        // whose two gold half-fixes were remembered partials — parked for the rest of the run
        // while g2 was reopened twice (jev-only-ladder-4-analysis.md §1.2). The picker (Q1) then
        // chooses among the reopened goals as among any open ones.
        const parked = mem.goals.filter((g) => g.status === 'parked');
        for (const g of parked) {
          g.status = 'open';
          g.budgetHits = 0;
          delete g.parkedReason;
          targets.push(g);
        }
        if (parked.length > 0) changes.push(`reopened ${parked.map((g) => g.id).join(', ')}`);
      }
      for (const goal of targets) {
        mem.overrides.sourceRotation[goal.id] = (mem.overrides.sourceRotation[goal.id] ?? 0) + 1;
        changes.push(`rotated source order of ${goal.id} (${mem.overrides.sourceRotation[goal.id]})`);
        if (mem.localizeCache.delete(goal.id)) changes.push(`sites of ${goal.id} rebuilt`);
      }
      if (mem.overrides.siteBeam < WIDENED_SITE_BEAM) {
        mem.overrides.siteBeam = WIDENED_SITE_BEAM;
        changes.push(`site beam ${DEFAULT_SITE_BEAM} → ${WIDENED_SITE_BEAM}`);
      }
      if (!mem.overrides.widenedOnRepos && (await isRepositoryWorkspace(ctx))) {
        mem.overrides.widenedOnRepos = true;
        changes.push('WIDENED phase enabled over the beam functions');
      }
      return done({ kind: 'continue', move, changes });
    }
    case 'gather_context': {
      const goal = activeGoal(mem);
      if (goal === null) return done({ kind: 'continue', move, changes });
      if (await isRepositoryWorkspace(ctx)) {
        const shown = new Set(ctx.contextFiles.map((f) => f.path));
        const unseen = goal.suspectedFiles.filter((p) => !shown.has(p));
        if (unseen.length > 0) {
          changes.push(`read ${unseen.length} suspected file${unseen.length > 1 ? 's' : ''} of ${goal.id}`);
          return done({ kind: 'proposal', move, proposal: proposeRead(ctx, unseen), changes });
        }
      }
      if (mem.localizeCache.delete(goal.id)) changes.push(`sites of ${goal.id} dropped`);
      if (mem.overrides.fileBeam < WIDENED_FILE_BEAM) {
        mem.overrides.fileBeam = WIDENED_FILE_BEAM;
        changes.push(`file beam ${DEFAULT_FILE_BEAM} → ${WIDENED_FILE_BEAM}`);
      }
      changes.push(`re-localise ${goal.id} with the latest failure text`);
      return done({ kind: 'continue', move, changes });
    }
    case 'fix_environment': {
      const command = engineTestCommand(ctx, mem);
      if (command === null) {
        changes.push('no test command known; nothing to run');
        return done({ kind: 'continue', move, changes });
      }
      changes.push('run the test command alone');
      return done({ kind: 'proposal', move, proposal: proposeRun(ctx, command, 'full', undefined, false, opts.runTimeoutMs), changes });
    }
    case 'revert_changes': {
      const last = mem.committed.at(-1);
      if (last === undefined) {
        changes.push('nothing committed to revert');
        return done({ kind: 'continue', move, changes });
      }
      const goal = goalForCommit(mem, last);
      // Memory first, then the proposal: should the reverse patch fail to apply, the dropped
      // baseline makes the next step re-run the suite and reconcile the ledger from the real workspace.
      mem.committed.pop();
      mem.baseline = null;
      if (goal) {
        goal.status = 'open';
        delete goal.parkedReason;
        mem.localizeCache.delete(goal.id);
        changes.push(`${goal.id} open again`);
      }
      changes.push(`revert ${last.candidate.op} at ${last.candidate.site.file.path}:${last.candidate.site.line}`);
      return done({ kind: 'proposal', move, proposal: proposeRevert(ctx, last, mem, { goal, reason: 'replan directive revert_changes' }), changes });
    }
  }
}

// ---------------------------------------------------------------------------------------
// Stale sites after a failed patch (§5.3)
// ---------------------------------------------------------------------------------------

export interface FailedPatch {
  step: number;
  /** paths named in the window's `patch <paths>` label ([] when the label carried none) */
  paths: string[];
  reason: string;
}

/** The previous step's `patch` whose outcome was `failed` (did not apply), else null. */
export function patchFailedLastStep(ctx: SynthesisContext): FailedPatch | null {
  const last = ctx.window.at(-1);
  if (last === undefined || last.outcome !== 'failed') return null;
  const m = /^patch(?:\s+(.*))?$/.exec(last.action);
  if (m === null) return null;
  const paths = (m[1] ?? '')
    .split(/\s+/)
    .filter((p) => p.length > 0 && !/^\(\+\d+ more\)$/.test(p));
  return { step: last.step, paths, reason: last.reason ?? '' };
}

/**
 * Invalidate the localisation cache of every goal whose sites the failed patch touched (by the
 * cached sites' files or the goal's suspected files); when no goal matches, the active goal's,
 * since the patch was for it. Returns the goal ids invalidated.
 */
export function invalidateStaleSites(ctx: SynthesisContext, mem: DirectiveMemory): string[] {
  const failed = patchFailedLastStep(ctx);
  if (failed === null) return [];
  const touched = new Set(failed.paths);
  const stale: string[] = [];
  for (const g of mem.goals) {
    const cached = mem.localizeCache.get(g.id);
    const cachedPaths = cached ? cached.sites.map((s) => s.file.path) : [];
    if (g.suspectedFiles.some((p) => touched.has(p)) || cachedPaths.some((p) => touched.has(p))) stale.push(g.id);
  }
  if (stale.length === 0) {
    const goal = activeGoal(mem);
    if (goal) stale.push(goal.id);
  }
  for (const id of stale) mem.localizeCache.delete(id);
  if (stale.length > 0) ctx.emit({ type: 'synth', step: ctx.step, phase: 'stale_sites', detail: `patch failed at step ${failed.step}; re-localising ${stale.join(', ')}` });
  return stale;
}
