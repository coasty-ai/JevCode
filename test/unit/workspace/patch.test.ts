import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PatchError, PathEscapeError, SecretPathError } from '../../../src/errors.js';
import { parsePatchFiles } from '../../../src/workspace/patch.js';
import { FIXTURES, initRepo, makeWorkspace, tempWs, write } from './helpers.js';
import type { TempWs } from './helpers.js';

const fixture = (n: string): string => readFileSync(join(FIXTURES, n), 'utf8');
const A_PY = 'def f():\n    return 1\n\n';

let temps: TempWs[] = [];
function ws(): TempWs {
  const t = tempWs();
  temps.push(t);
  return t;
}
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

describe('parsePatchFiles', () => {
  it('reads ---/+++ pairs, /dev/null and renames', () => {
    expect(parsePatchFiles(fixture('patch-ok.diff'))).toEqual([
      { oldPath: 'src/a.py', newPath: 'src/a.py' },
      { oldPath: null, newPath: 'src/new.py' },
    ]);
    expect(parsePatchFiles('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n')).toEqual([{ oldPath: 'x', newPath: 'y' }]);
    expect(parsePatchFiles('--- a/x\t2020-01-01\n+++ b/x\t2020-01-02\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([{ oldPath: 'x', newPath: 'x' }]);
    expect(parsePatchFiles('--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n')).toEqual([{ oldPath: 'sp ace.txt', newPath: 'sp ace.txt' }]);
  });

  it('never mistakes hunk-body lines for headers (removed "-- comment" reads "--- comment")', () => {
    const sql = 'diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,2 @@\n select 1;\n--- old comment\n rename from x\n';
    expect(parsePatchFiles(sql)).toEqual([{ oldPath: 'q.sql', newPath: 'q.sql' }]);
    const md = '--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n-+++ heading\n+--- heading\n@@ -0,0 +1 @@\n+--- a/fake\n--- a/other.md\n+++ b/other.md\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parsePatchFiles(md)).toEqual([
      { oldPath: 'README.md', newPath: 'README.md' },
      { oldPath: 'other.md', newPath: 'other.md' },
    ]);
  });

  it('reads files from diff --git headers that carry no text hunks (mode-only, binary)', () => {
    expect(parsePatchFiles('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n')).toEqual([{ oldPath: 'run.sh', newPath: 'run.sh' }]);
    expect(parsePatchFiles('diff --git a/sp ace/f b/sp ace/f\nold mode 100644\nnew mode 100755\n')).toEqual([{ oldPath: 'sp ace/f', newPath: 'sp ace/f' }]);
    expect(parsePatchFiles('diff --git "a/q\\"x" "b/q\\"x"\nold mode 100644\nnew mode 100755\n')).toEqual([{ oldPath: 'q"x', newPath: 'q"x' }]);
    expect(parsePatchFiles('diff --git a/img.png b/img.png\nindex 0000000..1111111\nBinary files a/img.png and b/img.png differ\n')).toEqual([{ oldPath: 'img.png', newPath: 'img.png' }]);
    // a header followed by ---/+++ is not reported twice
    expect(parsePatchFiles(fixture('patch-ok.diff'))).toHaveLength(2);
    expect(() => parsePatchFiles('diff --git a/../x b/../x\nold mode 100644\nnew mode 100755\n')).not.toThrow();
  });
});

describe('applyPatch', () => {
  it('applies a good patch in a git repo and reports changed files', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': A_PY });
    const w = await makeWorkspace(t);
    const r = await w.applyPatch(fixture('patch-ok.diff'));
    expect(r.changedFiles.sort()).toEqual(['src/a.py', 'src/new.py']);
    expect(readFileSync(join(t.ws, 'src/a.py'), 'utf8')).toBe('def f():\n    return 2\n\n');
    expect(readFileSync(join(t.ws, 'src/new.py'), 'utf8')).toBe('print("new")\n');
    expect(await w.changedFiles()).toEqual(['src/a.py', 'src/new.py']);
    expect((await w.listCandidates()).map((c) => c.path)).toContain('src/new.py');
  });

  it('applies outside a git repository too', async () => {
    const t = ws();
    write(t.ws, 'src/a.py', A_PY);
    const w = await makeWorkspace(t);
    expect((await w.info()).git).toBe(false);
    const r = await w.applyPatch(fixture('patch-ok.diff'));
    expect(r.changedFiles).toHaveLength(2);
    expect(readFileSync(join(t.ws, 'src/new.py'), 'utf8')).toBe('print("new")\n');
    expect(await w.changedFiles()).toEqual(['src/a.py', 'src/new.py']);
  });

  it('a failing hunk -> PatchError with git message as hunk, tree untouched (all-or-nothing)', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': A_PY });
    const w = await makeWorkspace(t);
    let err: unknown;
    try {
      await w.applyPatch(fixture('patch-bad-hunk.diff'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchError);
    expect((err as PatchError).hunk).toMatch(/patch does not apply|error:/);
    expect((err as PatchError).message).toMatch(/^PatchError: /);
    expect(readFileSync(join(t.ws, 'src/a.py'), 'utf8')).toBe(A_PY);
    expect(await w.changedFiles()).toEqual([]);
  });

  it('a multi-file patch with one bad hunk changes nothing', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': A_PY, 'src/b.py': 'b = 1\n' });
    const w = await makeWorkspace(t);
    const diff = '--- a/src/b.py\n+++ b/src/b.py\n@@ -1 +1 @@\n-b = 1\n+b = 2\n' + fixture('patch-bad-hunk.diff');
    await expect(w.applyPatch(diff)).rejects.toBeInstanceOf(PatchError);
    expect(readFileSync(join(t.ws, 'src/b.py'), 'utf8')).toBe('b = 1\n');
  });

  it('../ traversal, absolute and secret header paths are rejected before git runs', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': A_PY });
    const w = await makeWorkspace(t);
    await expect(w.applyPatch(fixture('patch-traversal.diff'))).rejects.toBeInstanceOf(PatchError);
    expect(existsSync(join(t.base, 'outside', 'evil.txt'))).toBe(false);
    await expect(w.applyPatch(fixture('patch-absolute.diff'))).rejects.toBeInstanceOf(PatchError);
    expect(existsSync('/tmp/jevcode-abs-escape/abs.txt')).toBe(false);
    expect(existsSync(join(t.ws, 'tmp'))).toBe(false);
    await expect(w.applyPatch(fixture('patch-secret.diff'))).rejects.toBeInstanceOf(SecretPathError);
    await expect(w.applyPatch('--- a/.git/config\n+++ b/.git/config\n@@ -0,0 +1 @@\n+x\n')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(w.applyPatch('')).rejects.toBeInstanceOf(PatchError);
    await expect(w.applyPatch('just text\n')).rejects.toBeInstanceOf(PatchError);
  });

  it('applies a hunk that removes a "-- comment" line and a mode-only patch', async () => {
    const t = ws();
    initRepo(t.ws, { 'q.sql': 'select 1;\n-- old comment\nselect 2;\n', 'run.sh': '#!/bin/sh\n' });
    const w = await makeWorkspace(t);
    const r = await w.applyPatch('--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,2 @@\n select 1;\n--- old comment\n select 2;\n');
    expect(r.changedFiles).toEqual(['q.sql']);
    expect(readFileSync(join(t.ws, 'q.sql'), 'utf8')).toBe('select 1;\nselect 2;\n');
    expect(statSync(join(t.ws, 'run.sh')).mode & 0o111).toBe(0);
    const m = await w.applyPatch('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
    expect(m.changedFiles).toEqual(['run.sh']);
    expect(statSync(join(t.ws, 'run.sh')).mode & 0o111).not.toBe(0);
    chmodSync(join(t.ws, 'run.sh'), 0o644);
  });

  it('a workspace that is a subdirectory of its repository applies diff --git patches to the right files', async () => {
    const t = ws();
    initRepo(t.ws, { 'sub/src/a.py': A_PY, 'top.txt': 'top\n' });
    const sub = join(t.ws, 'sub');
    const { createWorkspace } = await import('../../../src/workspace/files.js');
    const { createSandbox } = await import('../../../src/sandbox/run.js');
    const sandbox = createSandbox({ workspaceRoot: sub, runDir: t.runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { ttyPath: null });
    const w = await createWorkspace(sub, t.runDir, { sandbox, secretPaths: [], redact: (s) => s });
    expect((await w.info()).git).toBe(true);
    const r = await w.applyPatch(fixture('patch-ok.diff'));
    expect(r.changedFiles.sort()).toEqual(['src/a.py', 'src/new.py']);
    // git apply from a subdirectory would otherwise skip these paths silently (exit 0, no change)
    expect(readFileSync(join(sub, 'src/a.py'), 'utf8')).toBe('def f():\n    return 2\n\n');
    expect(readFileSync(join(sub, 'src/new.py'), 'utf8')).toBe('print("new")\n');
    await expect(w.applyPatch('--- a/../top.txt\n+++ b/../top.txt\n@@ -1 +1 @@\n-top\n+x\n')).rejects.toBeInstanceOf(PatchError);
    expect(readFileSync(join(t.ws, 'top.txt'), 'utf8')).toBe('top\n');
  });

  it('a symlink-traversing path is rejected by resolveInside', async () => {
    const t = ws();
    initRepo(t.ws, { 'src/a.py': A_PY });
    const { symlinkSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(t.base, 'outside'));
    symlinkSync(join(t.base, 'outside'), join(t.ws, 'link'));
    const w = await makeWorkspace(t);
    await expect(w.applyPatch('--- /dev/null\n+++ b/link/x.txt\n@@ -0,0 +1 @@\n+x\n')).rejects.toBeInstanceOf(PathEscapeError);
    expect(existsSync(join(t.base, 'outside', 'x.txt'))).toBe(false);
  });
});
