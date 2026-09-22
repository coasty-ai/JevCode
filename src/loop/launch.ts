/**
 * The launch (docs/ORCHESTRATION-DESIGN.md §5.7 + [D1]), the post-`run` escape diff (§2.4 [G8]) and
 * the `/undo` / `/rewind` facts a landed merge leaves behind (§5.7 tail, corner row 44).
 *
 * Everything here is PURE over the injected `RunGit` seam, which is why it lives beside
 * `src/loop/engine.ts` instead of inside it: the engine's job is to run the step, and §5.7's whole
 * point is that the launch is *an ordinary judged step* — "do not build a parallel path". So this
 * module produces `Proposal`s and `BlockingRequest`s, and the engine seeds them into the normal
 * `risk → confirm → takePreImages → execute → takePostImages → judge` sequence.
 *
 * [D1] is the blocker revision 1 missed. A JevCode parent is uncommitted BY CONSTRUCTION (§3.1
 * admits up to 200 dirty entries and §2.3 syncs exactly those files into every worktree), so the
 * dock's diff can touch a path the user has locally modified and `git merge` then aborts with
 * `Your local changes to the following files would be overwritten by merge` — deterministically, on
 * any real session, and invisibly to a clean fixture repo. The pre-flight is therefore not optional
 * polish: without it the launch is broken on the normal case.
 */
import { ORCHESTRATE_SUBDIR, diffNames, dirtyPaths, outsideOwn, type RunGit, type SyncedDirtyEntry } from '../orchestrate/index.js';
import type { Action, LandPreflightOffer, LaunchInput, PlanDraft, Proposal, RunMeta } from '../core/types.js';

// §5.7's two shapes live in `src/core/types.ts` under the `// contract 1.5` block, next to `Engine.land`, and are
// re-exported here so every §5.7 caller has one import.
export type { LandPreflightOffer, LaunchInput };

export { ORCHESTRATE_SUBDIR };

// ---------------------------------------------------------------------------------------
// §2.4 [G8] — the post-`run` escape diff
// ---------------------------------------------------------------------------------------

export interface EscapeInput {
  /** the post-image diff of the step: `ActionOutcome.changedFiles` after a `run` */
  changed: readonly string[];
  own: readonly string[];
  /** `orchestration.syncedDirty` VERBATIM — the still-carried subset is computed by the facade */
  syncedDirty: readonly SyncedDirtyEntry[];
  incidentalGlobs?: readonly string[];
  /** the volume folds case, as §3.4 rule 3 computed it for this run */
  fold?: boolean;
}

/**
 * `post-image diff ∩ complement(own) ∖ carried`, where `carried` is `carriedPaths(dir, syncedDirty)`
 * — the still-byte-identical subset, computed inside the facade's `outsideOwn`.
 *
 * **[D2] review finding 1 lives here.** Subtracting the whole `syncedDirty` list instead of the
 * still-carried subset turns belt 2 off for up to `DIRTY_ENTRIES_MAX` (200) paths: every file the
 * parent had left dirty would be exempt from the escape report for the whole run, including one a
 * sibling agent rewrote — exactly the two-agent collision §2.4 exists to catch. So this function
 * never sees a raw path list: it hands `syncedDirty` to `outsideOwn`, which does the sha compare.
 */
export async function escapedPaths(dir: string, input: EscapeInput): Promise<string[]> {
  if (input.changed.length === 0) return [];
  // review 2026-09-22 finding 4: an empty `own` owns NOTHING, so everything this `run` touched escaped it.
  // `outsideOwn` would answer the same, but it needs a git call to do it; this is the cheap, obvious form.
  if (input.own.length === 0) return [...new Set(input.changed)].sort();
  return outsideOwn(dir, {
    changed: input.changed,
    own: input.own,
    syncedDirty: input.syncedDirty,
    incidentalGlobs: input.incidentalGlobs ?? [],
    fold: input.fold ?? false,
  });
}

/** §2.4: the row text — `wrote 1 file outside its slice: package-lock.json`. */
export function escapedLine(escaped: readonly string[]): string {
  return `wrote ${escaped.length} ${escaped.length === 1 ? 'file' : 'files'} outside its slice: ${escaped.join(', ')}`;
}

// ---------------------------------------------------------------------------------------
// §5.7 [D1] — the dirty-checkout pre-flight
// ---------------------------------------------------------------------------------------

/**
 * `overlap = statusPorcelain(<workspaceRoot>).paths ∩ git diff --name-only <baseSha>..<pinned>`.
 *
 * Sorted and deduplicated. A git read that fails yields an EMPTY overlap on the diff side only
 * (`diffNames` already returns `[]` on a refusal) — but a failing status read must NOT read as a
 * clean checkout, so `dirtyPaths`' `ok: false` is propagated and the caller asks rather than merges.
 */
export async function launchOverlap(runGit: RunGit, input: LaunchInput): Promise<{ overlap: string[]; ok: boolean }> {
  const [dirty, changed] = await Promise.all([dirtyPaths(runGit, input.workspaceRoot), diffNames(runGit, input.workspaceRoot, input.baseSha, input.pinned)]);
  const dock = new Set(changed);
  const overlap = [...new Set(dirty.paths.filter((p) => dock.has(p)))].sort();
  return { overlap, ok: dirty.ok };
}

/** §5.7 [D1]: the three answers, in the order the pane offers them. `[c]` is RECOMMENDED. */
export const LAUNCH_ANSWERS = ['commit', 'stash', 'stop'] as const;
export type LaunchAnswer = (typeof LAUNCH_ANSWERS)[number];

/** How many overlapping paths the offer names before it says "+N more". */
const OVERLAP_PATHS_SHOWN = 8;

/**
 * §5.7's offer. NOT a `BlockingRequest`: `BlockingKind` is consumed by four exhaustive sites in
 * `src/tui/**` and one `Record<BlockingKind, …>` in the TUI's own tests, so a `'land-preflight'`
 * member is not additive in this repo and belongs to a separate interface change (see the note on
 * `BlockingKind` in `src/core/types.ts`). §5.7 says "`/land` prints the paths and offers three
 * answers" anyway, so the offer is a value the caller renders and answers — a pane is one possible
 * renderer of it, not a requirement of the mechanism.
 *
 * `stop` / `exitCode` are carried so the offer can be turned into a `BlockingRequest` verbatim the
 * day the TUI's member lands: `[x]` is `human_pause` / exit 4, resumable, because nothing was
 * decided and the dock is intact and inspectable.
 *
 * Its three answers, verbatim in their prose:
 *   `[c]` commit them first as a judged step, then merge (RECOMMENDED — the only one whose result
 *         is a merge whose conflicts mean what they look like)
 *   `[s]` stash them as a judged step, then merge (the dock already carries your hunks)
 *   `[x]` cancel (the dock stays; `/diff` still works)
 */
export function landPreflightOffer(id: string, step: number, overlap: readonly string[], input: Pick<LaunchInput, 'dockBranch'>): LandPreflightOffer {
  const shown = overlap.slice(0, OVERLAP_PATHS_SHOWN);
  const more = overlap.length > OVERLAP_PATHS_SHOWN ? `, +${overlap.length - OVERLAP_PATHS_SHOWN} more` : '';
  return {
    id,
    step,
    kind: 'land-preflight',
    overlap: [...overlap],
    choices: ['c', 's', 'x'],
    detail:
      `${overlap.length} of your uncommitted ${overlap.length === 1 ? 'file is' : 'files are'} also changed by ${input.dockBranch} — ${shown.join(', ')}${more}` +
      ' · [c] commit them first as a judged step, then merge (recommended)' +
      ' · [s] stash them as a judged step, then merge' +
      ' · [x] cancel (the dock stays; /diff still works)',
    stop: 'human_pause',
    exitCode: 4,
  };
}

// ---------------------------------------------------------------------------------------
// §5.7 — the seeded actions. Every one is a `run` whose command `isExclusiveTreeCommand` already
// classifies as a whole-tree lock (`git merge|commit|stash` are all in its verb list), so the
// `exclusiveTree` §5.7 asks for falls out of the existing lease rule and is never set by hand.
// ---------------------------------------------------------------------------------------

/**
 * §5.7: every step the launch seeds is a `run` action, and the narrow type is load-bearing — `exclusiveTree` is
 * decided from the COMMAND, so a caller must be able to read `.command` without re-narrowing the `Action` union.
 */
export type RunAction = Extract<Action, { kind: 'run' }>;

/** §5.7: `git merge --no-ff --no-edit <pinned dock sha>`. The sha, never the ref [G3]. */
export function mergeAction(pinned: string): RunAction {
  return { kind: 'run', command: `git merge --no-ff --no-edit ${pinned}` };
}

/**
 * §5.7 `[c]`: `git add -- <overlap> && git commit --only -m "wip before landing N agents" -- <overlap>`.
 *
 * `--only` and the trailing pathspec are the whole point (review 2026-09-22 finding 2): a bare `git commit`
 * commits the WHOLE INDEX, so a file the user had staged themselves — deliberately, and never shown to the
 * harness — was swept into a harness commit they did not review. `--only` commits exactly the named paths and
 * leaves the rest of the index staged and uncommitted, which is what "commit the overlapping files" says.
 */
export function wipCommitAction(overlap: readonly string[], agents: number): RunAction {
  const paths = quoteAll(overlap);
  const message = shellQuote(`wip before landing ${agents} ${agents === 1 ? 'agent' : 'agents'}`);
  return { kind: 'run', command: `git add -- ${paths} && git commit --only -m ${message} -- ${paths}` };
}

/** §5.7 `[s]`: `git stash push -u -- <overlap>`. */
export function stashAction(overlap: readonly string[]): RunAction {
  return { kind: 'run', command: `git stash push -u -- ${quoteAll(overlap)}` };
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
function quoteAll(paths: readonly string[]): string {
  return paths.map(shellQuote).join(' ');
}

/** §5.7: the seeded proposal of an ordinary judged step — the harness writes the `goal`, the generator is not asked. */
export function launchProposal(action: Action, goal: string, plan: PlanDraft): Proposal {
  return { goal, action, plan, rawText: `harness-seeded: ${goal}` };
}

/**
 * The three seeds of §5.7, by answer. `'stop'` (`[x]`) seeds nothing: the dock stays.
 *
 * An EMPTY `overlap` also seeds nothing, whatever the answer (review 2026-09-22 finding 1). Both verbs take a
 * pathspec, and git reads an empty one as "everything": `git stash push -u --` takes the whole working tree,
 * tracked and untracked, and `git add -- && git commit` commits whatever the index held. There is no answer for
 * which "the overlapping files" being none of them means "all of them", so the guard is here rather than only at
 * the caller — `seedFor` is exported and the next caller will not remember.
 */
export function seedFor(answer: LaunchAnswer, overlap: readonly string[], input: LaunchInput, plan: PlanDraft): Proposal | null {
  if (overlap.length === 0) return null;
  if (answer === 'commit') return launchProposal(wipCommitAction(overlap, input.agents), `commit the ${overlap.length} overlapping file(s) before landing ${input.agents} agents`, plan);
  if (answer === 'stash') return launchProposal(stashAction(overlap), `stash the ${overlap.length} overlapping file(s) before landing ${input.agents} agents`, plan);
  return null;
}

// ---------------------------------------------------------------------------------------
// §5.7 tail / corner row 44 — `/undo` and `/rewind` across a land
// ---------------------------------------------------------------------------------------

/** §5.7: `RunMeta.landed[]`, newest last, with the dock branch and the merge commit. */
export type LandedEntry = NonNullable<RunMeta['landed']>[number];

/**
 * `/undo <step>` on a landed step: a merge commit cannot be restored from pre-images, so the skip
 * reason is `'landed'` and the offer is `[g] git revert <commit>` — itself a NEW judged step, with
 * risk, review, images and a transcript row like any other.
 */
export function landedUndoOffer(meta: Pick<RunMeta, 'landed'>, step: number): { reason: 'landed'; commit: string; offer: string; action: Action } | null {
  const row = (meta.landed ?? []).find((l) => l.step === step);
  if (row === undefined) return null;
  return { reason: 'landed', commit: row.commit, offer: `[g] git revert ${row.commit}`, action: { kind: 'run', command: `git revert --no-edit ${row.commit}` } };
}

/**
 * `/rewind` below the delegation step: refused, because the agent branches would be orphaned.
 * `RunMeta.undoUnavailableBelow` is the floor; the sentence is §5.7's own.
 */
export function rewindRefusal(meta: Pick<RunMeta, 'landed' | 'undoUnavailableBelow'>, toStep: number): string | null {
  const floor = meta.undoUnavailableBelow;
  if (floor === undefined || toStep >= floor) return null;
  const landed = meta.landed ?? [];
  const n = landed.length;
  return `${n} ${n === 1 ? 'agent' : 'agents'} landed at step ${floor}; rewind below it would leave the branches orphaned`;
}
