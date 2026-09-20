import { describe, expect, it } from 'vitest';
import { VERIFY_ITEM } from '../../../../src/synth/search/proposal.js';

import { directiveText } from '../../../../src/loop/stages/replan.js';
import {
  DEFAULT_FILE_BEAM,
  DEFAULT_SITE_BEAM,
  DirectiveError,
  FALLBACK_MOVE,
  WIDENED_FILE_BEAM,
  WIDENED_SITE_BEAM,
  activeGoal,
  goalForCommit,
  handleDirective,
  invalidateStaleSites,
  isRepositoryWorkspace,
  parseDirective,
  patchFailedLastStep,
  type DirectiveMove,
} from '../../../../src/synth/search/directive.js';
import { TEST_COMMAND, cachedLocalize, fileView, gcdApplied, makeCtx, makeGoal, makeMemory, patchEntry, runEntry, twoFileApplied } from './proposal-helpers.js';

const REPO_FILES = ['src/a.py', 'src/gcd.py', 'tests/test_gcd.py'];
const SINGLE_FILE = ['gcd.py', 'tests/test_gcd.py'];

function engineText(move: DirectiveMove): string {
  return directiveText(move, 'chosen', 0.61, 0.08, 'run:abc123def456:0123456789ab');
}

describe('parseDirective: the engine wording of every move', () => {
  it('maps each directiveText to its move, the fallback wording to change_approach, no text to null', () => {
    const table: [string | null, DirectiveMove | null][] = [
      [engineText('change_approach'), 'change_approach'],
      [engineText('gather_context'), 'gather_context'],
      [engineText('fix_environment'), 'fix_environment'],
      [engineText('revert_changes'), 'revert_changes'],
      [directiveText('none_of_these', 'fallback', 0.2, 0.1, 'patch:abc'), FALLBACK_MOVE],
      ['revert_changes', 'revert_changes'],
      ['something else entirely', FALLBACK_MOVE],
      [null, null],
      ['   ', null],
    ];
    for (const [text, expected] of table) expect(parseDirective(text)).toBe(expected);
  });
});

describe('isRepositoryWorkspace / activeGoal', () => {
  it('more than one non-test .py file is a repository; test files do not count', async () => {
    expect(await isRepositoryWorkspace(makeCtx({ files: REPO_FILES }))).toBe(true);
    expect(await isRepositoryWorkspace(makeCtx({ files: SINGLE_FILE }))).toBe(false);
    expect(await isRepositoryWorkspace(makeCtx({ files: ['gcd.py', 'tests/a.py', 'tests/b.py', 'conftest.py'] }))).toBe(false);
  });
  it('active before open; null when everything is fixed or parked', () => {
    const open = makeGoal({ id: 'o' });
    const active = makeGoal({ id: 'a', status: 'active' });
    expect(activeGoal(makeMemory({ goals: [open, active] }))?.id).toBe('a');
    expect(activeGoal(makeMemory({ goals: [open] }))?.id).toBe('o');
    expect(activeGoal(makeMemory({ goals: [makeGoal({ id: 'f', status: 'fixed' }), makeGoal({ id: 'p', status: 'parked' })] }))).toBeNull();
  });
});

describe('handleDirective: the §5.4 mapping table', () => {
  it('throws without a directive', async () => {
    await expect(handleDirective(makeCtx({ directive: null }), makeMemory())).rejects.toThrow(DirectiveError);
  });

  it('change_approach on a repository: rotate the active goal, widen the site beam 6 → 10, enable WIDENED, drop the goal sites, continue', async () => {
    const g = makeGoal({ id: 'g1', status: 'active', suspectedFiles: ['src/gcd.py'] });
    const other = makeGoal({ id: 'g2' });
    const mem = makeMemory({ goals: [g, other], localizeCache: new Map([['g1', cachedLocalize(['src/gcd.py'])], ['g2', cachedLocalize(['src/a.py'])]]) });
    const ctx = makeCtx({ directive: engineText('change_approach'), files: REPO_FILES });
    expect(mem.overrides.siteBeam).toBe(DEFAULT_SITE_BEAM);
    const r = await handleDirective(ctx, mem);
    expect(r.kind).toBe('continue');
    expect(r.move).toBe('change_approach');
    expect(mem.overrides.sourceRotation).toEqual({ g1: 1 });
    expect(mem.overrides.siteBeam).toBe(WIDENED_SITE_BEAM);
    expect(mem.overrides.widenedOnRepos).toBe(true);
    expect(mem.localizeCache.has('g1')).toBe(false);
    expect(mem.localizeCache.has('g2')).toBe(true);
    // a second directive rotates again and reports no beam change
    const r2 = await handleDirective(ctx, mem);
    expect(mem.overrides.sourceRotation).toEqual({ g1: 2 });
    expect(r2.changes.some((c) => c.includes('site beam'))).toBe(false);
    const synth = ctx.events.filter((e) => e.type === 'synth');
    expect(synth).toHaveLength(2);
    expect(synth[0]).toMatchObject({ type: 'synth', phase: 'directive' });
    if (synth[0]?.type === 'synth') expect(synth[0].detail).toMatch(/^change_approach: rotated source order of g1 \(1\); sites of g1 rebuilt; site beam 6 → 10; WIDENED phase enabled/);
  });

  it('change_approach on a single file never enables WIDENED on repos (it is already allowed there)', async () => {
    const mem = makeMemory({ goals: [makeGoal({ id: 'g1', status: 'active' })] });
    await handleDirective(makeCtx({ directive: engineText('change_approach'), files: SINGLE_FILE }), mem);
    expect(mem.overrides.widenedOnRepos).toBe(false);
    expect(mem.overrides.siteBeam).toBe(WIDENED_SITE_BEAM);
  });

  it('change_approach with every goal parked reopens EVERY parked goal in ledger order, each rotated and re-localised; fixed goals stay fixed', async () => {
    const p1 = makeGoal({ id: 'p1', status: 'parked', parkedReason: 'a', budgetHits: 2, attempts: 3 });
    const f = makeGoal({ id: 'f', status: 'fixed' });
    const p2 = makeGoal({ id: 'p2', status: 'parked', parkedReason: 'b', budgetHits: 2, attempts: 1 });
    const mem = makeMemory({ goals: [p1, f, p2], localizeCache: new Map([['p1', cachedLocalize(['src/p1.py'])]]) });
    const ctx = makeCtx({ directive: engineText('change_approach') });
    const r = await handleDirective(ctx, mem);
    expect(r.kind).toBe('continue');
    expect([p1, p2].map((g) => g.status)).toEqual(['open', 'open']);
    expect([p1, p2].map((g) => g.budgetHits)).toEqual([0, 0]);
    // attempts stand (§5.3 counts searches without a commit); the park reason goes
    expect([p1, p2].map((g) => g.attempts)).toEqual([3, 1]);
    expect('parkedReason' in p1 || 'parkedReason' in p2).toBe(false);
    expect(f.status).toBe('fixed');
    expect(mem.overrides.sourceRotation).toEqual({ p1: 1, p2: 1 });
    expect(mem.localizeCache.has('p1')).toBe(false);
    expect(r.changes).toEqual(['reopened p1, p2', 'rotated source order of p1 (1)', 'sites of p1 rebuilt', 'rotated source order of p2 (1)', `site beam ${DEFAULT_SITE_BEAM} → ${WIDENED_SITE_BEAM}`]);
    const synth = ctx.events.filter((e) => e.type === 'synth');
    if (synth[0]?.type === 'synth') expect(synth[0].detail).toMatch(/^change_approach: reopened p1, p2; rotated source order of p1 \(1\); sites of p1 rebuilt; rotated source order of p2 \(1\)/);
  });

  it('gather_context on a repository reads the suspected files the context stage did not show', async () => {
    const g = makeGoal({ id: 'g1', status: 'active', suspectedFiles: ['src/gcd.py', 'src/a.py', 'src/b.py'] });
    const ctx = makeCtx({ directive: engineText('gather_context'), files: REPO_FILES, contextFiles: [fileView('src/a.py')], plan: { remaining: [g.planItem], openProblems: ['keep'] } });
    const r = await handleDirective(ctx, makeMemory({ goals: [g] }));
    expect(r.kind).toBe('proposal');
    if (r.kind === 'proposal') {
      expect(r.proposal.action).toEqual({ kind: 'read', paths: ['src/gcd.py', 'src/b.py'] });
      expect(r.proposal.plan).toEqual({ done: [], remaining: [g.planItem], openProblems: ['keep'] });
    }
  });

  it('gather_context with everything shown (or on a single file) re-localises with a top-10 file beam', async () => {
    const g = makeGoal({ id: 'g1', status: 'active', suspectedFiles: ['src/gcd.py'] });
    const mem = makeMemory({ goals: [g], localizeCache: new Map([['g1', cachedLocalize(['src/gcd.py'])]]) });
    expect(mem.overrides.fileBeam).toBe(DEFAULT_FILE_BEAM);
    const shown = makeCtx({ directive: engineText('gather_context'), files: REPO_FILES, contextFiles: [fileView('src/gcd.py')] });
    const r = await handleDirective(shown, mem);
    expect(r.kind).toBe('continue');
    expect(mem.localizeCache.has('g1')).toBe(false);
    expect(mem.overrides.fileBeam).toBe(WIDENED_FILE_BEAM);
    expect(r.changes).toContain('re-localise g1 with the latest failure text');

    const single = makeMemory({ goals: [makeGoal({ id: 'g1', status: 'active', suspectedFiles: ['gcd.py'] })] });
    const r2 = await handleDirective(makeCtx({ directive: engineText('gather_context'), files: SINGLE_FILE }), single);
    expect(r2.kind).toBe('continue');
    expect(single.overrides.fileBeam).toBe(WIDENED_FILE_BEAM);
  });

  it('gather_context with no goal to gather for continues unchanged', async () => {
    const mem = makeMemory({ goals: [makeGoal({ id: 'f', status: 'fixed' })] });
    const r = await handleDirective(makeCtx({ directive: engineText('gather_context'), files: REPO_FILES }), mem);
    expect(r).toMatchObject({ kind: 'continue', changes: [] });
    expect(mem.overrides.fileBeam).toBe(DEFAULT_FILE_BEAM);
  });

  it('fix_environment runs the test command alone (workspace detection first, baseline command otherwise, nothing → continue)', async () => {
    const g = makeGoal({ id: 'g1', status: 'active' });
    const r = await handleDirective(makeCtx({ directive: engineText('fix_environment'), plan: { remaining: [g.planItem] } }), makeMemory({ goals: [g] }));
    expect(r.kind).toBe('proposal');
    if (r.kind === 'proposal') {
      expect(r.proposal.action).toEqual({ kind: 'run', command: TEST_COMMAND });
      expect(r.proposal.plan.done).toEqual([]);
      expect(r.proposal.plan.remaining).toEqual([g.planItem]);
    }
    const timed = await handleDirective(makeCtx({ directive: engineText('fix_environment') }), makeMemory({ goals: [g] }), { runTimeoutMs: 45_000 });
    expect(timed.kind === 'proposal' && timed.proposal.action).toEqual({ kind: 'run', command: TEST_COMMAND, timeoutMs: 45_000 });
    const fromBaseline = await handleDirective(makeCtx({ directive: engineText('fix_environment'), testCommand: null }), makeMemory({ goals: [g] }));
    expect(fromBaseline.kind === 'proposal' && fromBaseline.proposal.action.kind === 'run' && fromBaseline.proposal.action.command).toBe(TEST_COMMAND);
    const none = await handleDirective(makeCtx({ directive: engineText('fix_environment'), testCommand: null }), makeMemory({ goals: [g], baseline: null }));
    expect(none).toMatchObject({ kind: 'continue', changes: ['no test command known; nothing to run'] });
  });

  it('revert_changes: reverse patch of the last commit, the goal it fixed returns to remaining, the baseline is dropped', async () => {
    const applied = gcdApplied('src/gcd.py');
    const fixed = makeGoal({ id: 'g1', status: 'fixed', suspectedFiles: ['src/gcd.py'], tests: ['tests/test_gcd.py::test_gcd'] });
    const otherFixed = makeGoal({ id: 'g0', status: 'fixed', suspectedFiles: ['src/other.py'] });
    const mem = makeMemory({ goals: [otherFixed, fixed], committed: [twoFileApplied(), applied], localizeCache: new Map([['g1', cachedLocalize(['src/gcd.py'])]]) });
    const ctx = makeCtx({ directive: engineText('revert_changes'), plan: { done: [{ text: otherFixed.planItem, evidence: { step: 1, judged: 0.9 } }] } });
    const r = await handleDirective(ctx, mem);
    expect(r.kind).toBe('proposal');
    if (r.kind === 'proposal') {
      expect(r.proposal.goal).toBe('revert arg_swap at src/gcd.py:5');
      expect(r.proposal.action.kind).toBe('patch');
      if (r.proposal.action.kind === 'patch') {
        expect(r.proposal.action.diff).toContain('+        return gcd(a % b, b)');
        expect(r.proposal.action.diff).toContain('-        return gcd(b, a % b)');
      }
      expect(r.proposal.plan.done).toEqual([]);
      expect(r.proposal.plan.remaining).toEqual([fixed.planItem, VERIFY_ITEM]);
    }
    expect(mem.committed).toHaveLength(1);
    expect(mem.baseline).toBeNull();
    expect(fixed.status).toBe('open');
    expect(otherFixed.status).toBe('fixed');
    expect(mem.localizeCache.has('g1')).toBe(false);
    expect(r.changes).toEqual(['g1 open again', 'revert arg_swap at src/gcd.py:5']);
  });

  it('revert_changes with nothing committed continues', async () => {
    const mem = makeMemory({ goals: [makeGoal({ id: 'g1' })] });
    const r = await handleDirective(makeCtx({ directive: engineText('revert_changes') }), mem);
    expect(r).toMatchObject({ kind: 'continue', move: 'revert_changes', changes: ['nothing committed to revert'] });
    expect(mem.baseline).not.toBeNull();
  });

  it('goalForCommit: by touched suspected file, else the last fixed goal, else null', () => {
    const applied = gcdApplied('src/gcd.py');
    const a = makeGoal({ id: 'a', status: 'fixed', suspectedFiles: ['src/gcd.py'] });
    const b = makeGoal({ id: 'b', status: 'fixed', suspectedFiles: ['src/b.py'] });
    expect(goalForCommit(makeMemory({ goals: [a, b] }), applied)?.id).toBe('a');
    expect(goalForCommit(makeMemory({ goals: [b] }), applied)?.id).toBe('b');
    expect(goalForCommit(makeMemory({ goals: [makeGoal({ id: 'o' })] }), applied)).toBeNull();
  });
});

describe('patchFailedLastStep / invalidateStaleSites (§5.3)', () => {
  it('detects only a failed patch in the LAST window entry, with its paths and reason', () => {
    const failed = patchEntry({ step: 4, paths: ['src/gcd.py', 'src/b.py'], outcome: 'failed', reason: 'PatchError: hunk #1 failed' });
    expect(patchFailedLastStep(makeCtx({ window: [runEntry({ step: 3 }), failed] }))).toEqual({ step: 4, paths: ['src/gcd.py', 'src/b.py'], reason: 'PatchError: hunk #1 failed' });
    expect(patchFailedLastStep(makeCtx({ window: [failed, runEntry({ step: 5 })] }))).toBeNull();
    expect(patchFailedLastStep(makeCtx({ window: [patchEntry({ step: 4, outcome: 'executed' })] }))).toBeNull();
    expect(patchFailedLastStep(makeCtx({ window: [patchEntry({ step: 4, outcome: 'blocked', reason: 'risk' })] }))).toBeNull();
    expect(patchFailedLastStep(makeCtx({ window: [runEntry({ step: 4, outcome: 'failed' })] }))).toBeNull();
    expect(patchFailedLastStep(makeCtx({ window: [] }))).toBeNull();
    expect(patchFailedLastStep(makeCtx({ window: [patchEntry({ step: 4, paths: [], outcome: 'failed' })] }))).toEqual({ step: 4, paths: [], reason: '' });
  });

  it('invalidates the goals whose suspected or cached files the patch touched, else the active goal', () => {
    const g1 = makeGoal({ id: 'g1', status: 'active', suspectedFiles: ['src/gcd.py'] });
    const g2 = makeGoal({ id: 'g2', suspectedFiles: ['src/other.py'] });
    const g3 = makeGoal({ id: 'g3', suspectedFiles: ['src/x.py'] });
    const cache = () => new Map([['g1', cachedLocalize(['src/gcd.py'])], ['g2', cachedLocalize(['src/other.py'])], ['g3', cachedLocalize(['src/gcd.py'])]]);
    const mem = makeMemory({ goals: [g1, g2, g3], localizeCache: cache() });
    const ctx = makeCtx({ window: [patchEntry({ step: 4, paths: ['src/gcd.py'], outcome: 'failed', reason: 'PatchError' })] });
    expect(invalidateStaleSites(ctx, mem)).toEqual(['g1', 'g3']);
    expect([...mem.localizeCache.keys()]).toEqual(['g2']);
    expect(ctx.events.filter((e) => e.type === 'synth' && e.phase === 'stale_sites')).toHaveLength(1);

    const unlabelled = makeMemory({ goals: [g1, g2, g3], localizeCache: cache() });
    expect(invalidateStaleSites(makeCtx({ window: [patchEntry({ step: 4, paths: [], outcome: 'failed' })] }), unlabelled)).toEqual(['g1']);
    expect(unlabelled.localizeCache.has('g1')).toBe(false);

    const untouched = makeMemory({ goals: [g1, g2, g3], localizeCache: cache() });
    expect(invalidateStaleSites(makeCtx({ window: [runEntry({ step: 4 })] }), untouched)).toEqual([]);
    expect(untouched.localizeCache.size).toBe(3);
  });
});
