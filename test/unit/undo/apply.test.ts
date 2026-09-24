/**
 * TUI-DESIGN §12.4 / §12.5 / §19.0: `/undo` applied end to end over temp git repositories — every decision row
 * (restore via pre-image / unlink / git restore, refuse, ask default n with y·a·s·Esc·Enter, link / escape /
 * submodule skips, HEAD-moved skip, non-git), the §24 item text, the seed note, the `UndoLogEntry`, the
 * `post/<N>.json` → `.undone.json` rename, `applyRewind`'s stop-at-refusal, and `gitRestoreFromHead`'s per-path
 * fallback (never `checkout --`).
 */
import { chmod, link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { postImagePath, readPostImages } from '../../../src/checkpoint/images.js';
import { sha256Hex } from '../../../src/core/hash.js';
import { createFakeSandbox } from '../loop/fakes.js';
import {
  CURRENT_HASH_MAX_BYTES,
  NO_GIT_RUNNER,
  UNDO_ABORTED_REASON,
  UNDO_ITEM_LABEL,
  UNDO_VERIFY_ROUNDS,
  applyRewind,
  applyUndo,
  gitRestoreFromHead,
  prepareUndo,
  readCurrentFiles,
  readHeadOid,
  type ApplyUndoDeps,
} from '../../../src/undo/apply.js';
import { CHANGED_DURING_UNDO, KEPT_DECLINED, NOT_RECOVERABLE_COMMAND, NOT_RECOVERABLE_NO_GIT, askPrompt, headMovedMessage, refuseMessage, type UndoPlan } from '../../../src/undo/plan.js';
import { git, headOid, initRepo, recordingSandbox, stepChange, tempRepo, write, type TempRepo } from './helpers.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const NOW = '2026-09-20T13:00:00.000Z';
let temps: TempRepo[] = [];

function repo(files: Record<string, string> = { 'src/a.py': 'x = 1\n', 'src/b.py': 'y = 2\n', 'tests/test_a.py': 'def test(): pass\n', 'old.txt': 'to be deleted\n' }): TempRepo {
  const t = tempRepo();
  temps.push(t);
  initRepo(t.ws, files);
  return t;
}

function deps(t: TempRepo, over: Partial<ApplyUndoDeps> = {}): ApplyUndoDeps {
  return { runDir: t.runDir, runId: 'r1', root: t.ws, sandbox: t.sandbox, nowIso: () => NOW, ...over };
}

async function plan(t: TempRepo, step: number, over: { headOid?: string | null; git?: boolean; submodules?: readonly string[] } = {}): Promise<UndoPlan> {
  const r = await prepareUndo(t.runDir, step, { root: t.ws, headOid: over.headOid === undefined ? headOid(t.ws) : over.headOid, git: over.git ?? true, ...(over.submodules ? { submodules: over.submodules } : {}) });
  if (!r.ok) throw new Error(`prepareUndo: ${r.message}`);
  return r.plan;
}

const text = (t: TempRepo, rel: string): Promise<string> => readFile(join(t.ws, rel), 'utf8');

afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

describe('applyUndo: restore rows (§12.4 rows 1–2, source order pre-image → unlink → git restore)', () => {
  it('an edit step: pre-images written back with their mode, a created file unlinked with its new directory, a deleted file brought back; post/7.json renamed', async () => {
    const t = repo();
    await chmod(join(t.ws, 'src/b.py'), 0o755);
    git(t.ws, 'commit', '-q', '-am', 'mode');
    await stepChange(t, 7, ['src/a.py', 'src/b.py', 'src/new/deep/n.py', 'old.txt'], async () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
      write(t.ws, 'src/new/deep/n.py', 'new\n');
      await rm(join(t.ws, 'old.txt'));
    }, { source: 'edit' });
    const p = await plan(t, 7);
    expect(p.decisions.map((d) => d.kind)).toEqual(['restore', 'restore', 'restore', 'restore']);
    const r = await applyUndo(p, deps(t));
    expect(r.restored).toEqual(['src/a.py', 'src/b.py', 'src/new/deep/n.py', 'old.txt']);
    expect(r.skipped).toEqual([]);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
    expect((await stat(join(t.ws, 'src/b.py'))).mode & 0o777).toBe(0o755);
    expect(await text(t, 'old.txt')).toBe('to be deleted\n');
    expect(existsSync(join(t.ws, 'src/new/deep/n.py'))).toBe(false);
    // the recorded empty directories (deepest first) are gone; src/ itself was not created by the step
    expect(existsSync(join(t.ws, 'src/new'))).toBe(false);
    expect(existsSync(join(t.ws, 'src'))).toBe(true);
    // §24 item text, seed note, undoLog entry (§15 item 9)
    expect(r.summary).toBe('undo step 7: restored 4 files (src/a.py, src/b.py, src/new/deep/n.py, old.txt)');
    expect(r.label).toBe('[ui]');
    expect(UNDO_ITEM_LABEL).toBe('[ui]');
    expect(r.note).toBe('human reverted step 7: src/a.py, src/b.py, src/new/deep/n.py, old.txt');
    expect(r.entry).toEqual({ runId: 'r1', step: 7, at: NOW, by: 'undo', restored: ['src/a.py', 'src/b.py', 'src/new/deep/n.py', 'old.txt'], skipped: [] });
    expect(r).toMatchObject({ refused: false, aborted: false, undone: true, warnings: [] });
    // post/7.json → post/7.undone.json; a second /undo 7 says so
    expect(existsSync(postImagePath(t.runDir, 7))).toBe(false);
    expect(existsSync(postImagePath(t.runDir, 7, true))).toBe(true);
    const again = await prepareUndo(t.runDir, 7, { root: t.ws, headOid: headOid(t.ws), git: true });
    expect(again).toEqual({ ok: false, reason: 'undone', message: 'step 7 was already undone' });
    // git sees the tree as it was: nothing touched the index
    expect(git(t.ws, 'status', '--porcelain').trim()).toBe('');
  });

  it('a `run` step on clean tracked files (one clobbered, one deleted) restores both from an unchanged HEAD through `git restore --source=HEAD --worktree` (never checkout --)', async () => {
    const t = repo();
    const sb = recordingSandbox(t.sandbox);
    const clean = new Set(['src/a.py', 'src/b.py']);
    await stepChange(t, 3, [], async () => {
      write(t.ws, 'src/a.py', 'clobbered by a command\n');
      await rm(join(t.ws, 'src/b.py'));
    }, { source: 'run', cleanAtStart: (rel) => clean.has(rel) }, ['src/a.py', 'src/b.py', 'build/out.txt']);
    // build/out.txt never existed and was not clean at start: the image can only record it as gone, so it is a command change
    const p = await plan(t, 3);
    expect(p.decisions).toEqual([
      { kind: 'restore', path: 'src/a.py', via: 'git-restore', expected: { exists: true, sha256: sha256Hex('clobbered by a command\n') } },
      { kind: 'restore', path: 'src/b.py', via: 'git-restore', expected: { exists: false, sha256: null } },
      { kind: 'skip', path: 'build/out.txt', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND },
    ]);
    const r = await applyUndo(p, deps(t, { sandbox: sb }));
    expect(r.restored).toEqual(['src/a.py', 'src/b.py']);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
    expect(sb.commands).toHaveLength(1);
    expect(sb.commands[0]).toContain('restore --source=HEAD --worktree -- src/a.py src/b.py');
    for (const forbidden of ['checkout', '--staged', 'stash', 'reset', 'clean']) expect(sb.commands[0]).not.toContain(forbidden);
    expect(r.summary).toBe('undo step 3: restored 2 files (src/a.py, src/b.py), skipped 1 (build/out.txt: not recoverable — changed by a command, not tracked by git)');
    expect(r.undone).toBe(true);
    expect(git(t.ws, 'status', '--porcelain').trim()).toBe('');
  });

  it('an injected restoreFromHead (O5) is preferred over the sandbox; a failure becomes a not-recoverable skip', async () => {
    const t = repo();
    await stepChange(t, 3, [], () => write(t.ws, 'src/a.py', 'clobbered\n'), { source: 'run' }, ['src/a.py']);
    const calls: string[][] = [];
    const r = await applyUndo(await plan(t, 3), deps(t, { restoreFromHead: (paths) => (calls.push([...paths]), Promise.resolve({ restored: [], failed: [{ path: 'src/a.py', reason: 'boom' }] })) }));
    expect(calls).toEqual([['src/a.py']]);
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'src/a.py', reason: 'not-recoverable', message: 'git restore failed (boom)' }]);
    expect(r.summary).toBe('no files restored (src/a.py: git restore failed (boom))');
    expect(r.undone).toBe(false);
    expect(existsSync(postImagePath(t.runDir, 3))).toBe(true);
    // without either restorer the row is skipped with the §12.4 source named
    const bare = await applyUndo(await plan(t, 3), { runDir: t.runDir, runId: 'r1', root: t.ws, nowIso: () => NOW });
    expect(bare.skipped).toEqual([{ path: 'src/a.py', reason: 'not-recoverable', message: NO_GIT_RUNNER }]);
  });
});

describe('applyUndo: refuse (§12.4 row 3) and the ask row (§12.4 row 4, §24)', () => {
  it('a later step that recorded the current bytes refuses the whole undo: nothing written, no ask', async () => {
    const t = repo();
    await stepChange(t, 7, ['src/a.py', 'src/b.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
    }, { source: 'edit' });
    await stepChange(t, 9, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 3\n'), { source: 'edit' });
    const p = await plan(t, 7);
    expect(p.refusals).toHaveLength(1);
    let asked = 0;
    const r = await applyUndo(p, deps(t, { ask: () => (asked++, 'y') }));
    expect(asked).toBe(0);
    expect(r.refused).toBe(true);
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'src/a.py', reason: 'refused', message: refuseMessage('src/a.py', 7, 9) }]);
    expect(r.summary).toBe('no files restored (src/a.py: src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together)');
    expect(r.note).toBeNull();
    expect(r.entry).toBeNull();
    expect(await text(t, 'src/b.py')).toBe('y = 3\n'); // even the restorable file was left alone
    expect(existsSync(postImagePath(t.runDir, 7))).toBe(true);
  });

  it('a file changed outside JevCode asks; without an answer channel the default is n (kept, declined)', async () => {
    const t = repo();
    await stepChange(t, 7, ['src/a.py', 'src/b.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
    }, { source: 'edit' });
    write(t.ws, 'src/a.py', 'edited by hand\n');
    const p = await plan(t, 7);
    expect(p.asks.map((a) => a.prompt)).toEqual([askPrompt('src/a.py', 7)]);
    expect(p.asks[0]?.prompt).toBe('src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort');
    const r = await applyUndo(p, deps(t));
    expect(r.restored).toEqual(['src/b.py']);
    expect(r.skipped).toEqual([{ path: 'src/a.py', reason: 'declined', message: 'kept (declined)' }]);
    expect(await text(t, 'src/a.py')).toBe('edited by hand\n');
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
    expect(r.summary).toBe('undo step 7: restored 1 file (src/b.py), skipped 1 (src/a.py: kept (declined))');
    expect(r.entry?.skipped).toEqual([{ path: 'src/a.py', reason: 'declined' }]);
  });

  it('the per-file ask: y overwrites, n / Enter keep, a overwrites the rest, s keeps the rest, Esc aborts before any write; pre-seeded answers skip the callback', async () => {
    const files = ['src/a.py', 'src/b.py', 'tests/test_a.py'];
    const setup = async (): Promise<TempRepo> => {
      const t = repo();
      await stepChange(t, 7, [...files, 'old.txt'], async () => {
        for (const f of files) write(t.ws, f, `${f} changed by step 7\n`);
        await rm(join(t.ws, 'old.txt'));
      }, { source: 'edit' });
      for (const f of files) write(t.ws, f, `${f} edited by hand\n`);
      return t;
    };
    // y · n · Enter
    let t = await setup();
    const keys = ['y', 'n', 'enter'] as const;
    const seen: { path: string; index: number; total: number }[] = [];
    let r = await applyUndo(await plan(t, 7), deps(t, { ask: (a, pos) => (seen.push({ path: a.path, ...pos }), keys[seen.length - 1] ?? 'n') }));
    expect(seen).toEqual([{ path: 'src/a.py', index: 0, total: 3 }, { path: 'src/b.py', index: 1, total: 3 }, { path: 'tests/test_a.py', index: 2, total: 3 }]);
    expect(r.restored).toEqual(['src/a.py', 'old.txt']);
    expect(r.skipped.map((s) => `${s.path}:${s.reason}`)).toEqual(['src/b.py:declined', 'tests/test_a.py:declined']);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    expect(await text(t, 'src/b.py')).toBe('src/b.py edited by hand\n');
    // a = all remaining
    t = await setup();
    let asked = 0;
    r = await applyUndo(await plan(t, 7), deps(t, { ask: () => (asked++, 'a') }));
    expect(asked).toBe(1);
    expect(r.restored).toEqual(['src/a.py', 'src/b.py', 'tests/test_a.py', 'old.txt']);
    // s = skip rest (after one y)
    t = await setup();
    asked = 0;
    r = await applyUndo(await plan(t, 7), deps(t, { ask: () => (asked++ === 0 ? 'y' : 's') }));
    expect(asked).toBe(2);
    expect(r.restored).toEqual(['src/a.py', 'old.txt']);
    expect(r.skipped.map((s) => s.path)).toEqual(['src/b.py', 'tests/test_a.py']);
    // Esc = abort the whole undo: nothing written, not even the restorable old.txt
    t = await setup();
    r = await applyUndo(await plan(t, 7), deps(t, { ask: () => 'esc' }));
    expect(r).toMatchObject({ aborted: true, restored: [], undone: false, note: null, entry: null });
    expect(r.skipped).toEqual(files.map((f) => ({ path: f, reason: 'declined', message: KEPT_DECLINED })));
    expect(r.summary).toBe(`no files restored (${UNDO_ABORTED_REASON})`);
    expect(existsSync(join(t.ws, 'old.txt'))).toBe(false);
    expect(await text(t, 'src/a.py')).toBe('src/a.py edited by hand\n');
    expect(existsSync(postImagePath(t.runDir, 7))).toBe(true);
    // pre-seeded answers are not asked again; an unknown key reads as n; a throwing ask aborts
    t = await setup();
    const askedFor: string[] = [];
    r = await applyUndo(await plan(t, 7), deps(t, { answers: { 'src/a.py': true, 'src/b.py': false }, ask: (a) => (askedFor.push(a.path), 'bogus' as unknown as 'n') }));
    expect(askedFor).toEqual(['tests/test_a.py']);
    expect(r.restored).toEqual(['src/a.py', 'old.txt']);
    t = await setup();
    r = await applyUndo(await plan(t, 7), deps(t, { ask: () => Promise.reject(new Error('overlay gone')) }));
    expect(r.aborted).toBe(true);
  });

  it('a `sha256: null` post entry (hashing budget spent) is an ask row too, answered through the same channel', async () => {
    const t = repo();
    await stepChange(t, 2, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 2\n'), { source: 'edit' });
    // rewrite the post image as the 16 MiB cap would have left it
    const read = await readPostImages(t.runDir, 2);
    if (!read.ok) throw new Error('post image missing');
    const image = { ...read.image, hashSkipped: true, files: { 'src/a.py': { ...read.image.files['src/a.py']!, sha256: null } } };
    await writeFile(postImagePath(t.runDir, 2), `${JSON.stringify(image)}\n`);
    const p = await plan(t, 2);
    expect(p.asks).toHaveLength(1);
    const r = await applyUndo(p, deps(t, { ask: () => 'y' }));
    expect(r.restored).toEqual(['src/a.py']);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
  });
});

describe('applyUndo: skips (§12.4 rows link / escape / submodule / HEAD moved / non-git)', () => {
  it('a symlink or a hard link at the recorded path is skipped `link`; a directory replaced by a symlink out of the tree is `escape`; a submodule path is `submodule`', async () => {
    const t = repo();
    await mkdir(join(t.ws, 'sub'));
    write(t.ws, 'sub/x.txt', 'inside a submodule\n');
    await stepChange(t, 5, ['src/a.py', 'src/b.py', 'tests/test_a.py', 'sub/x.txt'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
      write(t.ws, 'tests/test_a.py', 'changed\n');
      write(t.ws, 'sub/x.txt', 'changed inside\n');
    }, { source: 'edit' });
    // outside JevCode: a.py becomes a symlink, b.py gains a hard link, tests/ is replaced by a symlink out of the tree
    await rm(join(t.ws, 'src/a.py'));
    await symlink('b.py', join(t.ws, 'src/a.py'));
    await link(join(t.ws, 'src/b.py'), join(t.ws, 'src/b.link'));
    await rename(join(t.ws, 'tests'), join(t.base, 'tests-outside'));
    await symlink(join(t.base, 'tests-outside'), join(t.ws, 'tests'));
    const p = await plan(t, 5, { submodules: ['sub'] });
    expect(p.decisions).toEqual([
      { kind: 'skip', path: 'src/a.py', reason: 'link', message: 'symlink or hard link' },
      { kind: 'skip', path: 'src/b.py', reason: 'link', message: 'symlink or hard link' },
      { kind: 'skip', path: 'tests/test_a.py', reason: 'escape', message: 'resolves outside the workspace or into .git' },
      { kind: 'skip', path: 'sub/x.txt', reason: 'submodule', message: 'submodule' },
    ]);
    const r = await applyUndo(p, deps(t));
    expect(r.restored).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['link', 'link', 'escape', 'submodule']);
    expect(r.summary).toBe('no files restored (src/a.py: symlink or hard link, src/b.py: symlink or hard link, tests/test_a.py: resolves outside the workspace or into .git, sub/x.txt: submodule)');
    // nothing restored: no undoLog entry for the next seed (§15 item 9)
    expect(r.entry).toBeNull();
    // nothing was written anywhere: the link targets and the outside directory are intact
    expect(await readFile(join(t.base, 'tests-outside/test_a.py'), 'utf8')).toBe('changed\n');
    expect(await text(t, 'src/b.py')).toBe('y = 3\n');
    expect(r.undone).toBe(false);
  });

  it('HEAD moved since the step: a clean tracked file a command changed is `not recoverable — HEAD moved since step N`', async () => {
    const t = repo();
    await stepChange(t, 4, [], () => write(t.ws, 'src/a.py', 'clobbered\n'), { source: 'run' }, ['src/a.py']);
    const before = headOid(t.ws);
    write(t.ws, 'src/b.py', 'y = 9\n');
    git(t.ws, 'commit', '-q', '-am', 'moved');
    const after = headOid(t.ws);
    expect(after).not.toBe(before);
    const p = await plan(t, 4);
    expect(p.decisions).toEqual([{ kind: 'skip', path: 'src/a.py', reason: 'head-moved', message: headMovedMessage(4) }]);
    const sb = recordingSandbox(t.sandbox);
    const r = await applyUndo(p, deps(t, { sandbox: sb }));
    expect(sb.commands).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'src/a.py', reason: 'head-moved', message: 'not recoverable — HEAD moved since step 4' }]);
    expect(r.summary).toBe('no files restored (src/a.py: not recoverable — HEAD moved since step 4)');
    expect(await text(t, 'src/a.py')).toBe('clobbered\n');
    // readHeadOid reads the same oid the fixture sees; null in a directory that is not a repository
    expect(await readHeadOid(t.sandbox, t.ws)).toBe(after);
    const plain = tempRepo();
    temps.push(plain);
    expect(await readHeadOid(plain.sandbox, plain.ws)).toBeNull();
  });

  it('a `run` step on a file that was not clean at start, or outside any repository, is `not recoverable` with the §24 reason', async () => {
    const t = repo();
    write(t.ws, 'notes.txt', 'untracked before the run\n');
    await stepChange(t, 6, [], () => write(t.ws, 'notes.txt', 'rewritten by a command\n'), { source: 'run', cleanAtStart: () => false }, ['notes.txt']);
    let r = await applyUndo(await plan(t, 6), deps(t));
    expect(r.skipped).toEqual([{ path: 'notes.txt', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND }]);
    expect(r.summary).toBe('no files restored (notes.txt: not recoverable — changed by a command, not tracked by git)');
    // non-git: rules 1–2 only; a run-changed file names the missing repository
    const plain = tempRepo();
    temps.push(plain);
    write(plain.ws, 'f.txt', 'before\n');
    await stepChange(plain, 1, [], () => write(plain.ws, 'f.txt', 'after\n'), { source: 'run', headOid: null }, ['f.txt']);
    await stepChange(plain, 2, ['g.txt'], () => write(plain.ws, 'g.txt', 'made\n'), { source: 'write', headOid: null });
    r = await applyUndo(await plan(plain, 1, { headOid: null, git: false }), deps(plain));
    expect(r.skipped).toEqual([{ path: 'f.txt', reason: 'not-recoverable', message: NOT_RECOVERABLE_NO_GIT }]);
    r = await applyUndo(await plan(plain, 2, { headOid: null, git: false }), deps(plain));
    expect(r.restored).toEqual(['g.txt']);
    expect(existsSync(join(plain.ws, 'g.txt'))).toBe(false);
  });

  it.skipIf(isRoot)('a write that fails (read-only parent) is a not-recoverable skip with the errno; the other files are still restored', async () => {
    const t = repo();
    await stepChange(t, 8, ['src/a.py', 'tests/test_a.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'tests/test_a.py', 'changed\n');
    }, { source: 'edit' });
    await chmod(join(t.ws, 'tests'), 0o500);
    try {
      const r = await applyUndo(await plan(t, 8), deps(t));
      expect(r.restored).toEqual(['src/a.py']);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]).toMatchObject({ path: 'tests/test_a.py', reason: 'not-recoverable' });
      expect(r.skipped[0]?.message).toMatch(/^write failed \((EACCES|EPERM)\)$/);
      expect(r.undone).toBe(true);
    } finally {
      await chmod(join(t.ws, 'tests'), 0o755);
    }
  });
});

describe('prepareUndo and readCurrentFiles (§12.4 inputs)', () => {
  it('missing / corrupt / already-undone steps are reported, not thrown; later images exclude undone steps', async () => {
    const t = repo();
    expect(await prepareUndo(t.runDir, 3, { root: t.ws, headOid: null, git: true })).toEqual({ ok: false, reason: 'missing', message: 'step 3 recorded no file changes' });
    await mkdir(join(t.runDir, 'post'), { recursive: true });
    await writeFile(postImagePath(t.runDir, 4), '{not json');
    const corrupt = await prepareUndo(t.runDir, 4, { root: t.ws, headOid: null, git: true });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt).toMatchObject({ reason: 'corrupt' });
    await stepChange(t, 7, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 2\n'), { source: 'edit' });
    await stepChange(t, 9, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 3\n'), { source: 'edit' });
    // undo 9 first, then 7 is no longer refused by it
    await applyUndo(await plan(t, 9), deps(t));
    const r = await prepareUndo(t.runDir, 7, { root: t.ws, headOid: headOid(t.ws), git: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.later).toEqual([]);
      expect(r.plan.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'pre-image', expected: { exists: true, sha256: sha256Hex('x = 2\n') } }]);
    }
  });

  it('readCurrentFiles: hashes regular files, flags symlinks, hard links, escapes (incl. `..`, absolute and .git paths) and submodule membership; big files keep sha256 null', async () => {
    const t = repo();
    write(t.ws, 'big.bin', 'x'.repeat(2048));
    await symlink('src/a.py', join(t.ws, 'lnk'));
    await link(join(t.ws, 'src/b.py'), join(t.ws, 'hard'));
    const cur = await readCurrentFiles(t.ws, ['src/a.py', 'lnk', 'hard', 'missing.txt', '../escape', '/abs', '.git/config', 'sub/inner/x', 'big.bin'], { submodules: ['sub'], hashMaxBytes: 1024 });
    expect(cur['src/a.py']).toMatchObject({ exists: true });
    expect(cur['src/a.py']?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cur['lnk']).toMatchObject({ exists: true, sha256: null, symlink: true });
    expect(cur['hard']).toMatchObject({ exists: true, sha256: null, nlink: 2 });
    expect(cur['missing.txt']).toEqual({ exists: false, sha256: null });
    expect(cur['../escape']).toEqual({ exists: false, sha256: null, escapes: true });
    expect(cur['/abs']).toEqual({ exists: false, sha256: null, escapes: true });
    expect(cur['.git/config']).toEqual({ exists: false, sha256: null, escapes: true });
    expect(cur['sub/inner/x']).toMatchObject({ exists: false, submodule: true });
    expect(cur['big.bin']).toMatchObject({ exists: true, sha256: null });
    expect(CURRENT_HASH_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('applyRewind (§12.5) and gitRestoreFromHead (§12.4, C40)', () => {
  it('undoes the given plans in order with by: rewind and stops at the first refusal', async () => {
    const t = repo();
    await stepChange(t, 7, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 2\n'), { source: 'edit' });
    await stepChange(t, 8, ['src/b.py'], () => write(t.ws, 'src/b.py', 'y = 3\n'), { source: 'edit' });
    await stepChange(t, 9, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 3\n'), { source: 'edit' });
    // plans computed before any undo: 7 is refused by 9 — the caller's picker orders last-first, and 7 comes after 9 is undone in practice;
    // here the stale plan for 7 exercises the stop rule
    const p9 = await plan(t, 9);
    const p8 = await plan(t, 8);
    const p7 = await plan(t, 7);
    const results = await applyRewind([p9, p8, p7], deps(t));
    expect(results.map((r) => [r.step, r.restored, r.refused, r.entry?.by ?? null])).toEqual([
      [9, ['src/a.py'], false, 'rewind'],
      [8, ['src/b.py'], false, 'rewind'],
      [7, [], true, null],
    ]);
    // a fresh plan for 7 (9 is undone now) restores it
    const p7b = await plan(t, 7);
    const [r7] = await applyRewind([p7b], deps(t));
    expect(r7?.restored).toEqual(['src/a.py']);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    // Esc in the first plan stops the rewind at once
    await stepChange(t, 10, ['src/a.py'], () => write(t.ws, 'src/a.py', 'x = 10\n'), { source: 'edit' });
    await stepChange(t, 11, ['src/b.py'], () => write(t.ws, 'src/b.py', 'y = 11\n'), { source: 'edit' });
    write(t.ws, 'src/b.py', 'by hand\n');
    const stopped = await applyRewind([await plan(t, 11), await plan(t, 10)], deps(t, { ask: () => 'esc' }));
    expect(stopped.map((r) => [r.step, r.aborted])).toEqual([[11, true]]);
    expect(await text(t, 'src/a.py')).toBe('x = 10\n');
  });

  it('gitRestoreFromHead: a batch with one unmatched pathspec falls back per path, restores the good ones and reports the bad one; invalid paths never reach git', async () => {
    const t = repo();
    const sb = recordingSandbox(t.sandbox);
    write(t.ws, 'src/a.py', 'changed\n');
    write(t.ws, 'src/b.py', 'changed\n');
    const r = await gitRestoreFromHead(sb, t.ws, ['src/a.py', 'nope.txt', 'src/b.py', '', '../x', '/abs']);
    expect(r.restored).toEqual(['src/a.py', 'src/b.py']);
    expect(r.failed).toEqual([
      { path: '', reason: 'invalid path' },
      { path: '../x', reason: 'invalid path' },
      { path: '/abs', reason: 'invalid path' },
      { path: 'nope.txt', reason: expect.stringContaining("pathspec 'nope.txt' did not match") as unknown as string },
    ]);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
    // one batch + three singles; every command is the one restore verb
    expect(sb.commands).toHaveLength(4);
    for (const c of sb.commands) {
      expect(c).toContain('restore --source=HEAD --worktree --');
      expect(c).not.toMatch(/checkout|--staged|stash|reset|clean/);
    }
    expect(await gitRestoreFromHead(sb, t.ws, [])).toEqual({ restored: [], failed: [] });
    // a single failing path is reported without a retry
    const before = sb.commands.length;
    const one = await gitRestoreFromHead(sb, t.ws, ['nope.txt']);
    expect(one.restored).toEqual([]);
    expect(one.failed).toHaveLength(1);
    expect(sb.commands.length - before).toBe(1);
    // a sandbox that throws is a per-path failure, not a rejection
    const throwing = createFakeSandbox(() => ({ rejectOnAbort: true }));
    const ac = new AbortController();
    ac.abort();
    const rejected = await gitRestoreFromHead(throwing, t.ws, ['src/a.py'], { signal: ac.signal });
    expect(rejected.restored).toEqual([]);
    expect(rejected.failed).toHaveLength(1);
  });
});

describe('applyUndo: literal pathspecs (§12.4, C40) — glob characters in recorded names', () => {
  it('a `run` step that changed only `pages/[id].tsx` and `a*.py` restores those two files and never the files the globs would match', async () => {
    const t = repo({ 'pages/[id].tsx': 'orig-id\n', 'pages/i.tsx': 'orig-i\n', 'a*.py': 'star\n', 'abc.py': 'abc\n' });
    const sb = recordingSandbox(t.sandbox);
    await stepChange(t, 3, [], () => {
      write(t.ws, 'pages/[id].tsx', 'changed by a command\n');
      write(t.ws, 'a*.py', 'changed too\n');
    }, { source: 'run' }, ['pages/[id].tsx', 'a*.py']);
    // the user's own, unrelated edits after the step
    write(t.ws, 'pages/i.tsx', 'PRECIOUS USER EDIT\n');
    write(t.ws, 'abc.py', 'PRECIOUS TOO\n');
    const p = await plan(t, 3);
    expect(p.decisions.map((d) => [d.path, d.kind])).toEqual([['pages/[id].tsx', 'restore'], ['a*.py', 'restore']]);
    const r = await applyUndo(p, deps(t, { sandbox: sb }));
    expect(r.restored).toEqual(['pages/[id].tsx', 'a*.py']);
    expect(r.summary).toBe('undo step 3: restored 2 files (pages/[id].tsx, a*.py)');
    expect(await text(t, 'pages/[id].tsx')).toBe('orig-id\n');
    expect(await text(t, 'a*.py')).toBe('star\n');
    expect(await text(t, 'pages/i.tsx')).toBe('PRECIOUS USER EDIT\n');
    expect(await text(t, 'abc.py')).toBe('PRECIOUS TOO\n');
    expect(sb.commands).toHaveLength(1);
    expect(sb.commands[0]).toContain("restore --source=HEAD --worktree -- 'pages/[id].tsx' 'a*.py'");
    // gitRestoreFromHead alone: the same rule, the batch and the per-path fallback both literal
    write(t.ws, 'pages/[id].tsx', 'again\n');
    write(t.ws, 'pages/i.tsx', 'STILL PRECIOUS\n');
    const one = await gitRestoreFromHead(t.sandbox, t.ws, ['pages/[id].tsx', 'nope.txt']);
    expect(one.restored).toEqual(['pages/[id].tsx']);
    expect(await text(t, 'pages/i.tsx')).toBe('STILL PRECIOUS\n');
  });
});

describe('applyUndo: re-verification before the first write (§12.4 "all checks before the first write")', () => {
  const NOTE = 'PRECIOUS USER WORK\n';

  it('a restore row edited between the plan and the write (no ask channel) is kept as `kept (changed during undo)`; the other rows are restored', async () => {
    const t = repo();
    await stepChange(t, 7, ['src/a.py', 'src/b.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
    }, { source: 'edit' });
    const p = await plan(t, 7);
    expect(p.decisions.map((d) => d.kind)).toEqual(['restore', 'restore']);
    write(t.ws, 'src/a.py', NOTE); // after the plan, before the apply
    const r = await applyUndo(p, deps(t));
    expect(r.restored).toEqual(['src/b.py']);
    expect(r.skipped).toEqual([{ path: 'src/a.py', reason: 'declined', message: CHANGED_DURING_UNDO }]);
    expect(await text(t, 'src/a.py')).toBe(NOTE);
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
    expect(r.summary).toBe(`undo step 7: restored 1 file (src/b.py), skipped 1 (src/a.py: ${CHANGED_DURING_UNDO})`);
    expect(r.entry?.skipped).toEqual([{ path: 'src/a.py', reason: 'declined' }]);
    // the same with pre-seeded answers only (the `--plain` twin collects them up front): no channel to re-ask through
    const t2 = repo();
    await stepChange(t2, 7, ['src/a.py', 'src/b.py'], () => {
      write(t2.ws, 'src/a.py', 'x = 2\n');
      write(t2.ws, 'src/b.py', 'y = 3\n');
    }, { source: 'edit' });
    write(t2.ws, 'src/b.py', 'by hand\n');
    const p2 = await plan(t2, 7);
    write(t2.ws, 'src/a.py', NOTE);
    const r2 = await applyUndo(p2, deps(t2, { answers: { 'src/b.py': true } }));
    expect(r2.restored).toEqual(['src/b.py']);
    expect(r2.skipped).toEqual([{ path: 'src/a.py', reason: 'declined', message: CHANGED_DURING_UNDO }]);
    expect(await text(t2, 'src/a.py')).toBe(NOTE);
  });

  it('a restore row mutated inside another file\'s ask is asked again through the same channel: n keeps it, y restores it, Esc aborts with nothing written', async () => {
    const setup = async (): Promise<TempRepo> => {
      const t = repo();
      await stepChange(t, 7, ['src/a.py', 'src/b.py', 'old.txt'], async () => {
        write(t.ws, 'src/a.py', 'x = 2\n');
        write(t.ws, 'src/b.py', 'y = 3\n');
        await rm(join(t.ws, 'old.txt'));
      }, { source: 'edit' });
      write(t.ws, 'src/b.py', 'b by hand\n'); // b.py is the ask row; a.py and old.txt are restore rows
      return t;
    };
    // n on the re-ask
    let t = await setup();
    let seen: { path: string; index: number; total: number; prompt: string }[] = [];
    let r = await applyUndo(await plan(t, 7), deps(t, {
      ask: (a, pos) => {
        seen.push({ path: a.path, prompt: a.prompt, ...pos });
        if (a.path === 'src/b.py') write(t.ws, 'src/a.py', NOTE); // the user edits a.py while b.py's overlay is open
        return 'n';
      },
    }));
    expect(seen).toEqual([
      { path: 'src/b.py', index: 0, total: 1, prompt: askPrompt('src/b.py', 7) },
      { path: 'src/a.py', index: 0, total: 1, prompt: askPrompt('src/a.py', 7) },
    ]);
    expect(r.restored).toEqual(['old.txt']);
    expect(r.skipped).toEqual([
      { path: 'src/a.py', reason: 'declined', message: KEPT_DECLINED },
      { path: 'src/b.py', reason: 'declined', message: KEPT_DECLINED },
    ]);
    expect(await text(t, 'src/a.py')).toBe(NOTE);
    // y on the re-ask: the user saw the new content and said overwrite
    t = await setup();
    seen = [];
    r = await applyUndo(await plan(t, 7), deps(t, {
      ask: (a) => {
        seen.push({ path: a.path, prompt: a.prompt, index: 0, total: 0 });
        if (a.path === 'src/b.py') {
          write(t.ws, 'src/a.py', NOTE);
          return 'n';
        }
        return 'y';
      },
    }));
    expect(seen.map((s) => s.path)).toEqual(['src/b.py', 'src/a.py']);
    expect(r.restored).toEqual(['src/a.py', 'old.txt']);
    expect(await text(t, 'src/a.py')).toBe('x = 1\n');
    // Esc on the re-ask: the whole undo aborts before the first write — old.txt is still gone
    t = await setup();
    r = await applyUndo(await plan(t, 7), deps(t, {
      ask: (a) => {
        if (a.path === 'src/b.py') {
          write(t.ws, 'src/a.py', NOTE);
          return 'y';
        }
        return 'esc';
      },
    }));
    expect(r).toMatchObject({ aborted: true, restored: [], undone: false, entry: null });
    expect(existsSync(join(t.ws, 'old.txt'))).toBe(false);
    expect(await text(t, 'src/a.py')).toBe(NOTE);
    expect(await text(t, 'src/b.py')).toBe('b by hand\n');
    expect(existsSync(postImagePath(t.runDir, 7))).toBe(true);
    // changed yet again during the re-ask: no third ask, the row is kept
    t = await setup();
    let asked = 0;
    r = await applyUndo(await plan(t, 7), deps(t, {
      ask: (a) => {
        asked += 1;
        write(t.ws, 'src/a.py', `${NOTE}${asked}\n`);
        return a.path === 'src/a.py' ? 'y' : 'n';
      },
    }));
    expect(UNDO_VERIFY_ROUNDS).toBe(2);
    expect(asked).toBe(2);
    expect(r.restored).toEqual(['old.txt']);
    expect(r.skipped).toEqual([
      { path: 'src/a.py', reason: 'declined', message: CHANGED_DURING_UNDO },
      { path: 'src/b.py', reason: 'declined', message: KEPT_DECLINED },
    ]);
    expect(await text(t, 'src/a.py')).toBe(`${NOTE}2\n`);
  });

  it('a restore row replaced by a symlink (or moved behind a symlinked directory out of the tree) during the ask is skipped link / escape, never written through', async () => {
    const t = repo();
    await stepChange(t, 5, ['src/a.py', 'src/b.py', 'tests/test_a.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
      write(t.ws, 'tests/test_a.py', 'changed\n');
    }, { source: 'edit' });
    write(t.ws, 'src/b.py', 'b by hand\n');
    const r = await applyUndo(await plan(t, 5), deps(t, {
      ask: async () => {
        await rm(join(t.ws, 'src/a.py'));
        await symlink('b.py', join(t.ws, 'src/a.py'));
        await rename(join(t.ws, 'tests'), join(t.base, 'tests-outside'));
        await symlink(join(t.base, 'tests-outside'), join(t.ws, 'tests'));
        return 'n' as const;
      },
    }));
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual([
      { path: 'src/a.py', reason: 'link', message: 'symlink or hard link' },
      { path: 'src/b.py', reason: 'declined', message: KEPT_DECLINED },
      { path: 'tests/test_a.py', reason: 'escape', message: 'resolves outside the workspace or into .git' },
    ]);
    expect(await text(t, 'src/b.py')).toBe('b by hand\n'); // the symlink target was not written through
    expect(await readFile(join(t.base, 'tests-outside/test_a.py'), 'utf8')).toBe('changed\n');
    expect(r.entry).toBeNull();
    expect(r.undone).toBe(false);
  });
});

describe('applyUndo: modes, directories, aborted signals, .git symlinks', () => {
  it.skipIf(isRoot || process.platform === 'win32')('the recorded mode is applied under a restrictive umask (writeFileAtomic alone would leave 0700)', async () => {
    const t = repo();
    await chmod(join(t.ws, 'src/b.py'), 0o755);
    git(t.ws, 'commit', '-q', '-am', 'mode');
    await stepChange(t, 7, ['src/a.py', 'src/b.py'], () => {
      write(t.ws, 'src/a.py', 'x = 2\n');
      write(t.ws, 'src/b.py', 'y = 3\n');
    }, { source: 'edit' });
    const p = await plan(t, 7);
    const before = process.umask(0o077);
    try {
      const r = await applyUndo(p, deps(t));
      expect(r.restored).toEqual(['src/a.py', 'src/b.py']);
    } finally {
      process.umask(before);
    }
    expect((await stat(join(t.ws, 'src/b.py'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(t.ws, 'src/a.py'))).mode & 0o777).toBe(0o644);
  });

  it('recorded directories are removed even when every created file was already gone (unlink ENOENT counts as restored)', async () => {
    const t = repo();
    await stepChange(t, 4, ['src/new/deep/n.py', 'src/new/m.py'], () => {
      write(t.ws, 'src/new/deep/n.py', 'n\n');
      write(t.ws, 'src/new/m.py', 'm\n');
    }, { source: 'write' });
    // the user deleted the created files by hand and left the directories behind
    await rm(join(t.ws, 'src/new/deep/n.py'));
    await rm(join(t.ws, 'src/new/m.py'));
    expect(existsSync(join(t.ws, 'src/new/deep'))).toBe(true);
    const p = await plan(t, 4);
    // a created file that is already missing "differs" from the recorded state: the ask row (overwrite = delete)
    expect(p.decisions.map((d) => d.kind)).toEqual(['ask', 'ask']);
    const r = await applyUndo(p, deps(t, { ask: () => 'a' }));
    expect(r.restored).toEqual(['src/new/deep/n.py', 'src/new/m.py']);
    expect(existsSync(join(t.ws, 'src/new'))).toBe(false);
    expect(existsSync(join(t.ws, 'src'))).toBe(true);
    expect(r.undone).toBe(true);
  });

  it('applyRewind with an already-aborted signal: git-restore rows fail cleanly as skips, nothing hangs or throws', async () => {
    const t = repo();
    await stepChange(t, 3, [], () => write(t.ws, 'src/a.py', 'clobbered\n'), { source: 'run' }, ['src/a.py']);
    await stepChange(t, 4, ['src/b.py'], () => write(t.ws, 'src/b.py', 'y = 3\n'), { source: 'edit' });
    const ac = new AbortController();
    ac.abort();
    const p4 = await plan(t, 4);
    const p3 = await plan(t, 3);
    const t0 = performance.now();
    const results = await applyRewind([p4, p3], deps(t, { signal: ac.signal }));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(results.map((r) => [r.step, r.restored, r.skipped.map((s) => `${s.path}:${s.reason}`)])).toEqual([
      [4, ['src/b.py'], []],
      [3, [], ['src/a.py:not-recoverable']],
    ]);
    expect(results[1]?.skipped[0]?.message).toMatch(/^git restore failed/);
    expect(results[1]?.entry).toBeNull();
    expect(await text(t, 'src/a.py')).toBe('clobbered\n');
    expect(await text(t, 'src/b.py')).toBe('y = 2\n');
  });

  it('readCurrentFiles: a symlink that resolves into .git (a linked directory or the file itself) is an escape', async () => {
    const t = repo();
    await symlink('.git', join(t.ws, 'gitlink'));
    await symlink('.git/config', join(t.ws, 'cfg'));
    const cur = await readCurrentFiles(t.ws, ['gitlink/config', 'cfg', 'src/a.py']);
    expect(cur['gitlink/config']).toMatchObject({ exists: true, sha256: null, escapes: true });
    expect(cur['cfg']).toMatchObject({ exists: true, sha256: null, symlink: true, escapes: true });
    expect(cur['src/a.py']).toMatchObject({ exists: true });
    expect(cur['src/a.py']?.escapes).toBeUndefined();
    expect(cur['src/a.py']?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
