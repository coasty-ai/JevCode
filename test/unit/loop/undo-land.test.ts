/**
 * docs/ORCHESTRATION-DESIGN.md §5.7 — the launch, its dirty-checkout pre-flight [D1], and what a
 * landed merge does to `/undo` and `/rewind` (§5.7 tail, corner rows 44 and 53).
 *
 * §5.7's whole claim is that the launch is ORDINARY: one judged step whose proposal the harness
 * seeds, going through `risk`, the review confirm, `takePreImages`, `execute`, `takePostImages` and
 * `judge` like any other — "do not build a parallel path". So the assertions below are mostly about
 * the step looking exactly like a normal step in `store.steps`, the transcript and the events.
 *
 * [D1] is the blocker revision 1 missed: a JevCode parent is uncommitted by construction, so when
 * the dock's diff touches a path the user has locally modified, `git merge` aborts deterministically
 * with `Your local changes to the following files would be overwritten by merge`. The pre-flight
 * therefore proposes NO merge at all and offers `[c]` / `[s]` / `[x]`, each itself a judged step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, turn } from './fakes.js';
import { git, headSha, tempRepo, write, type TempRepo } from '../orchestrate/helpers.js';
import {
  LAUNCH_ANSWERS,
  landPreflightOffer,
  landedUndoOffer,
  launchOverlap,
  launchProposal,
  mergeAction,
  rewindRefusal,
  seedFor,
  stashAction,
  wipCommitAction,
  type LaunchInput,
} from '../../../src/loop/launch.js';
import { isExclusiveTreeCommand } from '../../../src/coordination/leases.js';
import type { PlanDraft, RunMeta } from '../../../src/core/types.js';

const harnesses: Harness[] = [];
const repos: TempRepo[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const r of repos.splice(0)) r.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
function repo(files?: Record<string, string>): TempRepo {
  const r = tempRepo(files);
  repos.push(r);
  return r;
}
const emptyPlan: PlanDraft = { done: [], remaining: [], openProblems: [] };

/** a fixture with a dock branch that changed `a.ts` and `b.ts` on top of `base`. */
function withDock(): { r: TempRepo; base: string; pinned: string; input: LaunchInput } {
  const r = repo({ 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'c.ts': 'c0\n' });
  const base = headSha(r.ws);
  git(r.ws, 'checkout', '-q', '-b', 'jevcode/dock-a2fee9c1');
  write(r.ws, 'a.ts', 'a1\n');
  write(r.ws, 'b.ts', 'b1\n');
  git(r.ws, 'add', '-A');
  git(r.ws, 'commit', '-q', '-m', 'agents');
  const pinned = headSha(r.ws);
  git(r.ws, 'checkout', '-q', 'main');
  return { r, base, pinned, input: { workspaceRoot: r.ws, baseSha: base, pinned, agents: 3, dockBranch: 'jevcode/dock-a2fee9c1' } };
}

describe('§5.7 [D1] — the pre-flight overlap', () => {
  it('a CLEAN checkout has an empty overlap: the merge is seeded exactly as written', async () => {
    const { r, input, pinned } = withDock();
    const { overlap, ok } = await launchOverlap(r.runGit, input);
    expect(ok).toBe(true);
    expect(overlap).toEqual([]);
    expect(mergeAction(pinned)).toEqual({ kind: 'run', command: `git merge --no-ff --no-edit ${pinned}` });
  });

  it('overlap = statusPorcelain(workspaceRoot).paths ∩ git diff --name-only base..pinned', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n'); // in the dock's diff → overlaps
    write(r.ws, 'c.ts', 'locally edited\n'); // NOT in the dock's diff → does not
    write(r.ws, 'untracked.ts', 'new\n'); // untracked and not in the diff → does not
    const { overlap } = await launchOverlap(r.runGit, input);
    expect(overlap).toEqual(['a.ts']);
  });

  it('a git merge into that dirty checkout really does abort — the failure [D1] exists to prevent', () => {
    const { r, pinned } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    expect(() => git(r.ws, 'merge', '--no-ff', '--no-edit', pinned)).toThrow(/local changes|would be overwritten/i);
  });
});

describe('§5.7 [D1] — the three answers, each an ordinary judged step (corner row 53)', () => {
  it('the offer names the paths and the three choices, and [x] is the resumable human_pause', () => {
    const { input } = withDock();
    const offer = landPreflightOffer('id1', 12, ['a.ts', 'src/loop/engine.ts'], input);
    expect(offer.kind).toBe('land-preflight');
    expect(offer.choices).toEqual(['c', 's', 'x']);
    expect(offer.detail).toContain('2 of your uncommitted files are also changed by jevcode/dock-a2fee9c1');
    expect(offer.detail).toContain('a.ts, src/loop/engine.ts');
    expect(offer.detail).toContain('[c] commit them first as a judged step, then merge (recommended)');
    expect(offer.detail).toContain('[s] stash them as a judged step, then merge');
    expect(offer.detail).toContain('[x] cancel (the dock stays; /diff still works)');
    expect(offer.stop).toBe('human_pause');
    expect(offer.exitCode).toBe(4);
  });

  it('[c] seeds `git add -- <overlap> && git commit --only -m "wip before landing N agents" -- <overlap>`', () => {
    // --only + the trailing pathspec: review 2026-09-22 finding 2 (a bare `git commit` takes the whole index)
    expect(wipCommitAction(['a.ts', "pages/[slug].tsx"], 3)).toEqual({ kind: 'run', command: `git add -- 'a.ts' 'pages/[slug].tsx' && git commit --only -m 'wip before landing 3 agents' -- 'a.ts' 'pages/[slug].tsx'` });
  });

  it('[s] seeds `git stash push -u -- <overlap>`', () => {
    expect(stashAction(['a.ts'])).toEqual({ kind: 'run', command: `git stash push -u -- 'a.ts'` });
  });

  it('[x] seeds nothing at all', () => {
    const { input } = withDock();
    expect(seedFor('stop', ['a.ts'], input, emptyPlan)).toBeNull();
    expect([...LAUNCH_ANSWERS]).toEqual(['commit', 'stash', 'stop']);
  });

  it('every seeded command is exclusiveTree by construction (git merge | commit | stash are whole-tree verbs)', () => {
    expect(isExclusiveTreeCommand(mergeAction('deadbeef').command)).toBe(true);
    expect(isExclusiveTreeCommand(wipCommitAction(['a.ts'], 3).command)).toBe(true);
    expect(isExclusiveTreeCommand(stashAction(['a.ts']).command)).toBe(true);
  });
});

describe('§5.7 — Engine.land seeds ordinary judged steps', () => {
  /** an engine over a real repo, whose sandbox executes the seeded git command for real */
  async function engineOver(r: TempRepo, extra: Partial<Parameters<typeof makeEngine>[0]> = {}): Promise<Harness> {
    const ws = createFakeWorkspace({ root: r.ws });
    ws.changedFiles = async () => [];
    return build({
      turns: [turn({ kind: 'done', summary: 'nothing more' })],
      workspace: ws,
      // a REAL shell, so `git add -- 'a.ts' && git commit -m '…'` is executed the way the sandbox would run it
      sandbox: createFakeSandbox((command) => {
        const out = spawnSync('sh', ['-c', command], {
          cwd: r.ws,
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: r.ws, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
        });
        return execResult({ exitCode: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '', ok: out.status === 0 });
      }),
      ...extra,
    });
  }

  it('an empty overlap seeds the merge, which runs as an ordinary step and lands (RunMeta.landed + undoUnavailableBelow)', async () => {
    const { r, input, pinned } = withDock();
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: r.runGit } } });
    const res = await h.engine.land!({ ...input, delegationStep: 11 });
    expect(res).toEqual({ seeded: 'merge', overlap: [] });
    await h.engine.run();

    const merge = h.store.steps.find((s) => s.proposal?.action.kind === 'run' && s.proposal.action.command.startsWith('git merge'));
    expect(merge).toBeDefined();
    // ordinary: it has a risk assessment, an outcome and a record like every other step
    expect(merge!.risk).not.toBeNull();
    expect(merge!.outcome?.status).toBe('executed');
    expect(merge!.proposal!.action).toEqual(mergeAction(pinned));

    expect(h.store.meta!.landed).toEqual([{ step: merge!.step, branch: 'jevcode/dock-a2fee9c1', commit: headSha(r.ws) }]);
    expect(h.store.meta!.undoUnavailableBelow).toBe(11);
    expect(git(r.ws, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2); // a real --no-ff merge commit
  });

  it('[c]: a non-empty overlap proposes NO merge — it seeds the wip commit, and the re-run pre-flight is then clean', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: r.runGit } } });
    const res = await h.engine.land!(input, async () => 'commit');
    expect(res.seeded).toBe('commit');
    expect(res.overlap).toEqual(['a.ts']);
    await h.engine.run();

    const steps = h.store.steps.filter((s) => s.proposal?.action.kind === 'run');
    expect(steps).toHaveLength(1);
    const action = steps[0]!.proposal!.action;
    expect(action.kind === 'run' && action.command.startsWith('git add --')).toBe(true);
    // NO merge was proposed in the same breath
    expect(h.store.steps.some((s) => s.proposal?.action.kind === 'run' && s.proposal.action.command.includes('git merge'))).toBe(false);
    // and now the pre-flight is clean, so the merge can be seeded as a SECOND judged step
    expect((await launchOverlap(r.runGit, input)).overlap).toEqual([]);
  });

  it('[s]: the stash is seeded instead, and it too is one ordinary judged step', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: r.runGit } } });
    const res = await h.engine.land!(input, async () => 'stash');
    expect(res.seeded).toBe('stash');
    await h.engine.run();
    const action = h.store.steps[0]!.proposal!.action;
    expect(action.kind === 'run' && action.command).toBe(`git stash push -u -- 'a.ts'`);
  });

describe('review 2026-09-22 finding 1 — a failed `git status` is its own case, never an empty-overlap offer', () => {
  it('seedFor returns null on an EMPTY overlap for every answer: an empty pathspec is a whole-tree verb', () => {
    const { input } = withDock();
    // `git stash push -u --` with no pathspec stashes the whole working tree, and `git add -- && git commit`
    // commits whatever the index already held. Neither is ever what the pre-flight meant to seed.
    expect(seedFor('stash', [], input, emptyPlan)).toBeNull();
    expect(seedFor('commit', [], input, emptyPlan)).toBeNull();
    expect(seedFor('stop', [], input, emptyPlan)).toBeNull();
    // a non-empty overlap is unaffected
    expect(seedFor('stash', ['a.ts'], input, emptyPlan)).not.toBeNull();
  });

  it('REAL GIT: `git stash push -u --` with an empty pathspec really does take the whole tree (why the guard exists)', () => {
    const { r } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    write(r.ws, 'untracked.ts', 'new\n');
    git(r.ws, 'stash', 'push', '-u', '--');
    expect(git(r.ws, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(join(r.ws, 'untracked.ts'))).toBe(false);
  });

  it('a failing `git status --porcelain` REFUSES: nothing is seeded, nothing is committed or stashed, the tree is untouched', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    write(r.ws, 'untracked.ts', 'new\n');
    const before = git(r.ws, 'status', '--porcelain');
    const head = headSha(r.ws);
    // the one seam that fails: `status --porcelain` (a corrupt index, a permission error, a git that is not there)
    const brokenGit: typeof r.runGit = async (cwd, args, opts) => {
      if (args.includes('status')) return execResult({ exitCode: 128, ok: false, stdout: '', stderr: 'fatal: not a git repository' });
      return r.runGit(cwd, args, opts);
    };
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: brokenGit } } });
    const res = await h.engine.land!(input, async () => 'stash');

    expect(res).toEqual({ seeded: null, overlap: [] });
    expect(h.of('transcript').some((t) => t.text.includes('could not read your checkout (git status failed): nothing was committed or stashed'))).toBe(true);
    // and the offer was never made: a refusal is not three choices over an empty list
    expect(h.of('transcript').some((t) => t.text.includes('[c] commit them first'))).toBe(false);
    await h.engine.run();
    expect(h.store.steps.some((st) => st.proposal?.action.kind === 'run' && /git (stash|commit|merge)/.test(st.proposal.action.command))).toBe(false);
    // the working tree is byte-for-byte what it was
    expect(git(r.ws, 'status', '--porcelain')).toBe(before);
    expect(headSha(r.ws)).toBe(head);
    expect(git(r.ws, 'stash', 'list').trim()).toBe('');
    expect(existsSync(join(r.ws, 'untracked.ts'))).toBe(true);
  });
});

describe('review 2026-09-22 finding 2 — [c] commits ONLY the overlap, never the rest of the index', () => {
  it('wipCommitAction uses `git commit --only … -- <overlap>`', () => {
    expect(wipCommitAction(['a.ts', 'pages/[slug].tsx'], 3)).toEqual({
      kind: 'run',
      command: `git add -- 'a.ts' 'pages/[slug].tsx' && git commit --only -m 'wip before landing 3 agents' -- 'a.ts' 'pages/[slug].tsx'`,
    });
  });

  it('REAL GIT: a separately staged, unrelated file is NOT swept into the harness commit', () => {
    const { r } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n'); // the overlap
    write(r.ws, 'c.ts', 'the user staged this themselves\n');
    git(r.ws, 'add', '--', 'c.ts'); // staged, deliberately, and NOT reviewed by the harness
    const action = wipCommitAction(['a.ts'], 3);
    const out = spawnSync('sh', ['-c', action.command], {
      cwd: r.ws,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: r.ws, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    expect(out.status).toBe(0);
    // the commit holds a.ts and nothing else
    expect(git(r.ws, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean)).toEqual(['a.ts']);
    // and the user's own staged file is still staged, still uncommitted
    expect(git(r.ws, 'diff', '--cached', '--name-only').trim()).toBe('c.ts');
  });
});

  it('[x]: nothing is seeded, the dock stays, and the transcript says /diff still works', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    const dockBefore = git(r.ws, 'rev-parse', 'jevcode/dock-a2fee9c1').trim();
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: r.runGit } } });
    const res = await h.engine.land!(input, async () => 'stop');
    expect(res).toEqual({ seeded: null, overlap: ['a.ts'] });
    await h.engine.run();
    expect(h.store.steps.some((s) => s.proposal?.action.kind === 'run')).toBe(false);
    expect(git(r.ws, 'rev-parse', 'jevcode/dock-a2fee9c1').trim()).toBe(dockBefore);
    expect(h.of('transcript').map((t) => t.text).join('\n')).toContain('/diff still works');
    // nothing landed
    expect(h.store.meta!.landed).toBeUndefined();
  });

  it('no asker (headless) is [x]: the offer is printed and NO merge is proposed', async () => {
    const { r, input } = withDock();
    write(r.ws, 'a.ts', 'locally edited\n');
    const h = await engineOver(r, { engine: { orchestration: { depth: 0, runGit: r.runGit } } });
    const res = await h.engine.land!(input);
    expect(res.seeded).toBeNull();
    expect(h.of('transcript').map((t) => t.text).join('\n')).toContain('[c] commit them first');
  });

  it('no runGit seam = no launch at all (an ordinary run is untouched)', async () => {
    const { r, input } = withDock();
    const h = await engineOver(r);
    expect(await h.engine.land!(input)).toEqual({ seeded: null, overlap: [] });
    await h.engine.run();
    expect(h.store.steps.some((s) => s.proposal?.action.kind === 'run')).toBe(false);
  });
});

describe('§5.7 tail / corner row 44 — /undo and /rewind across a land', () => {
  const meta: Pick<RunMeta, 'landed' | 'undoUnavailableBelow'> = {
    landed: [{ step: 12, branch: 'jevcode/dock-a2fee9c1', commit: 'a'.repeat(40) }],
    undoUnavailableBelow: 12,
  };

  it("/undo on a landed step cannot restore images: UndoSkipReason 'landed' and [g] git revert <commit> as a NEW judged step", () => {
    const offer = landedUndoOffer(meta, 12);
    expect(offer).toEqual({ reason: 'landed', commit: 'a'.repeat(40), offer: `[g] git revert ${'a'.repeat(40)}`, action: { kind: 'run', command: `git revert --no-edit ${'a'.repeat(40)}` } });
    // the revert is an ordinary judged step: a `run` proposal, exclusiveTree by its verb
    const p = launchProposal(offer!.action, 'revert the landed merge', emptyPlan);
    expect(p.action.kind).toBe('run');
    expect(landedUndoOffer(meta, 11)).toBeNull(); // an ordinary step still undoes from images
  });

  it('/rewind below the delegation step is refused with the §5.7 sentence', () => {
    expect(rewindRefusal(meta, 11)).toBe('1 agent landed at step 12; rewind below it would leave the branches orphaned');
    expect(rewindRefusal({ ...meta, landed: [meta.landed![0]!, { step: 12, branch: 'b', commit: 'b'.repeat(40) }] }, 5)).toBe('2 agents landed at step 12; rewind below it would leave the branches orphaned');
    expect(rewindRefusal(meta, 12)).toBeNull(); // at or above the floor is allowed
    expect(rewindRefusal({}, 1)).toBeNull(); // a run with no delegation is never refused
  });
});
