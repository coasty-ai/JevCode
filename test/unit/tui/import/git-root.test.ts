/**
 * TUI-DESIGN-5 §5.5 / §5.2 — **one** `gitRootOf`, and the five shapes it has to get right.
 *
 * The defect this file exists for: `/import` (the App) and `jevcode import` (the CLI) each had a function of
 * this name with a different answer. The App stripped a trailing `/.git` off the renderer's `gitDir`; the CLI
 * walked up for any `.git` entry. In a LINKED WORKTREE — which the tree this was found on is — `gitDir` is
 * `<main>/.git/worktrees/<name>`, so the App answered `null` and planned no project scope while the CLI planned
 * one. Same workspace, two plans, and neither side had a test.
 *
 * Everything below runs against the `GitRootFs` seam, so no repository is created and no `git` runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_PARENTS, gitRootFrom, gitRootOf, type GitRootFs } from '../../../../src/tui/import/git-root.js';

/** a fake tree: every path in `entries` exists, nothing else does */
function fsOf(...entries: readonly string[]): GitRootFs {
  const set = new Set(entries);
  return { existsSync: (p) => set.has(p) };
}

describe('gitRootOf — the one derivation both import sinks use (§5.5)', () => {
  it('a plain clone: the workspace itself, and any directory under it', () => {
    const fs = fsOf('/w/proj/.git');
    expect(gitRootOf('/w/proj', fs)).toBe('/w/proj');
    expect(gitRootOf('/w/proj/src/tui', fs)).toBe('/w/proj');
  });

  it('a LINKED WORKTREE, where `.git` is a FILE: the worktree root, not null and not the main checkout', () => {
    // `git worktree add` writes a `.git` FILE containing `gitdir: /main/.git/worktrees/wt`
    const fs = fsOf('/main/.git', '/main/wt/.git');
    expect(gitRootOf('/main/wt', fs)).toBe('/main/wt');
    expect(gitRootOf('/main/wt/src', fs)).toBe('/main/wt');
    // the old App derivation would have produced `/main/.git/worktrees` here; the walk stops at the worktree
    expect(gitRootOf('/main/wt', fs)).not.toBe('/main');
  });

  it('a submodule (also a `.git` FILE) resolves to the submodule, not the superproject', () => {
    const fs = fsOf('/w/super/.git', '/w/super/vendor/lib/.git');
    expect(gitRootOf('/w/super/vendor/lib', fs)).toBe('/w/super/vendor/lib');
  });

  it('a bare repo has no work tree above it: `null` unless some parent is itself a checkout', () => {
    expect(gitRootOf('/srv/repos/x.git', fsOf())).toBeNull();
    // and a bare repo INSIDE a checkout still answers the checkout, which is what the engine scopes to
    expect(gitRootOf('/w/proj/tmp/x.git', fsOf('/w/proj/.git'))).toBe('/w/proj');
  });

  it('no repository anywhere: `null` — the engine reads that as "no project scope"', () => {
    expect(gitRootOf('/tmp/jevcode-pty-ws-abc', fsOf())).toBeNull();
  });

  it('a trailing slash, a relative segment and an empty string are all normalised, never "//.git"', () => {
    const fs = fsOf('/w/proj/.git');
    expect(gitRootOf('/w/proj/', fs)).toBe('/w/proj');
    expect(gitRootOf('/w/proj/src/../src', fs)).toBe('/w/proj');
    expect(gitRootOf('', fs)).toBeNull();
    expect(gitRootOf('   ', fs)).toBeNull();
  });

  it('the walk is BOUNDED and never spins: a deep path gives up at MAX_PARENTS, and `/` terminates it', () => {
    let calls = 0;
    const counting: GitRootFs = {
      existsSync: () => {
        calls += 1;
        return false;
      },
    };
    expect(gitRootOf(`/${'a/'.repeat(200)}`, counting)).toBeNull();
    expect(calls).toBeLessThanOrEqual(MAX_PARENTS);
    calls = 0;
    expect(gitRootOf('/', counting)).toBeNull();
    expect(calls).toBe(1);
  });

  it('gitRootFrom prefers `GitState.topLevel` — the answer git itself gave — and falls back to the walk', () => {
    const fs = fsOf('/w/proj/.git');
    // the session probed it: no walk at all, and the probe wins even when the walk would say something else
    expect(gitRootFrom('/w/proj/src', '/main/wt', fs)).toBe('/main/wt');
    expect(gitRootFrom('/w/proj/src', '/main/wt/', fs)).toBe('/main/wt');
    // `probeGit` reports `''` for a bare repo and `null` before the probe: both fall through to the walk
    expect(gitRootFrom('/w/proj/src', '', fs)).toBe('/w/proj');
    expect(gitRootFrom('/w/proj/src', null, fs)).toBe('/w/proj');
    expect(gitRootFrom('/w/proj/src', undefined, fs)).toBe('/w/proj');
  });
});

describe('§13.1 — the CLI twin plans the same scope', () => {
  /**
   * `src/cli/main.tsx` is G1's file this wave, so the hunk that replaces its private copy with an import of this
   * module is filed as a request rather than applied here. Until it lands, this case pins the property that
   * matters: the CLI's copy is the SAME algorithm (a bounded `existsSync` walk for a `.git` entry, not a
   * `statSync().isDirectory()` test and not a `git` spawn), so the two answers cannot diverge silently. It keeps
   * passing once the request lands, because then there is no second copy to compare against.
   */
  it('`jevcode import` derives the root with this module, or with the identical bounded walk', () => {
    const src = readFileSync(new URL('../../../../src/cli/main.tsx', import.meta.url), 'utf8');
    const importsShared = /from '\.\.\/tui\/import\/git-root\.js'/.test(src);
    if (importsShared) {
      expect(src).not.toMatch(/function gitRootOf\(/);
      return;
    }
    const body = /function gitRootOf\(workspace: string\): string \| null \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(body, 'src/cli/main.tsx has no gitRootOf to compare').not.toBe('');
    expect(body).toContain("existsSync(joinPath(dir, '.git'))");
    expect(body).toContain(`i < ${MAX_PARENTS}`);
    // never a spawn on the argv path (gate G-R5-1), and never `isDirectory()` (a worktree's `.git` is a file)
    expect(body).not.toContain('isDirectory');
    expect(body).not.toContain('spawn');
  });
});
