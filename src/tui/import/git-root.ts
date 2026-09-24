/**
 * TUI-DESIGN-5 §5.5 / §5.2: **one** `gitRootOf`, for both sinks of the import plan.
 *
 * `ImportEnvironment.gitRoot` decides the plan's PROJECT scope — whether `<root>/CLAUDE.md` and `<root>/.mcp.json`
 * are in the plan at all. `/import` in the session and `jevcode import` on the command line must therefore agree
 * about it for the same workspace, and until this module existed they did not: the App derived the root from the
 * renderer's `gitDir` by stripping a trailing `/.git`, which answers `null` for a **linked worktree** (whose
 * `gitDir` is `<main>/.git/worktrees/<name>`), while the CLI walked up for any `.git` entry and answered the
 * worktree root. Two answers, one workspace, one silently smaller plan.
 *
 * The rules, stated once:
 *
 *  - a bounded walk of at most `MAX_PARENTS` directories, so a pathological path cannot spin;
 *  - `existsSync`, **not** `statSync().isDirectory()` — in a linked worktree `.git` is a FILE
 *    (`gitdir: /path/to/main/.git/worktrees/x`), and a submodule's `.git` is a file too;
 *  - **no spawn.** Gate G-R5-1 keeps `node:child_process` off the argv path, and `jevcode import` reaches this
 *    before anything else runs;
 *  - `null` when there is none, which the engine reads as "no project scope".
 *
 * A caller that already probed git (`probeGit(...).topLevel`, which the session does at startup) should pass that
 * instead of walking — `gitRootFrom` is the one-line front door for exactly that case.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/** The walk's bound: deep enough for any real checkout, finite for a cyclic or adversarial path. */
export const MAX_PARENTS = 64;

/** The one filesystem call this module makes, as a seam so the unit cases need no real repository. */
export interface GitRootFs {
  existsSync(path: string): boolean;
}

const NODE_FS: GitRootFs = { existsSync: (p) => existsSync(p) };

/** `normalize` keeps a trailing separator (`/w/proj/`), and a root that ends in one compares unequal everywhere. */
function tidy(path: string): string {
  const p = normalize(path);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * The git root at or above `workspace`, or `null`. Pure apart from `fs.existsSync`; never throws on a path that
 * does not exist (a missing directory simply has no `.git` and the walk continues upwards).
 */
export function gitRootOf(workspace: string, fs: GitRootFs = NODE_FS): string | null {
  if (typeof workspace !== 'string' || workspace.trim() === '') return null;
  let dir = tidy(isAbsolute(workspace) ? normalize(workspace) : resolve(workspace));
  for (let i = 0; i < MAX_PARENTS; i++) {
    // a linked worktree and a submodule both have a `.git` FILE, so this is `existsSync` and not `isDirectory()`
    if (fs.existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * §5.2: the App's front door. `topLevel` is `GitState.topLevel` — what `probeGit` already computed for the
 * session's resolved workspace — and it WINS when it is there, because it came from git itself and costs nothing.
 * Absent (no probe yet, no repository, a bare repo whose `topLevel` is `''`), the bounded walk answers.
 */
export function gitRootFrom(workspace: string, topLevel: string | null | undefined, fs: GitRootFs = NODE_FS): string | null {
  if (typeof topLevel === 'string' && topLevel !== '') return tidy(topLevel);
  return gitRootOf(workspace, fs);
}
