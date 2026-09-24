/**
 * import/discover.ts slugToPath (IMPORT-DESIGN §3.2; §6 row 15).
 *
 * Claude's project slug is the absolute path with `/` → `-`, which is **not reversible** once the
 * path itself contains `-`. The fixtures are the three shapes that matter: a plain path, a path
 * whose last segment already holds dashes, and a worktree path under `.claude/worktrees/`.
 */
import { describe, expect, it } from 'vitest';
import { mergeWorktreeRoot, slugOfPath, slugToPath } from '../../../src/import/discover.js';

const PATHS = {
  plain: '/home/dev/projects/Example',
  dashed: '/home/dev/projects/example-rl-envs',
  worktree: '/home/dev/projects/JevCode/.claude/worktrees/llm-jev-int',
} as const;

const SLUGS = {
  plain: '-home-dev-projects-Example',
  dashed: '-home-dev-projects-example-rl-envs',
  worktree: '-home-dev-projects-JevCode--claude-worktrees-llm-jev-int',
} as const;

describe('slugOfPath — the three shapes', () => {
  it.each(Object.keys(PATHS) as (keyof typeof PATHS)[])('%s', (k) => {
    expect(slugOfPath(PATHS[k])).toBe(SLUGS[k]);
  });

  it('the doubled dash is where /.claude/ was, and that is exactly why it is not reversible', () => {
    expect(SLUGS.worktree).toContain('JevCode--claude-worktrees');
    // two different paths can produce slugs a naive reverse would confuse
    expect(slugOfPath('/a/b-c')).toBe('-a-b-c');
    expect(slugOfPath('/a-b/c')).toBe('-a-b-c');
  });
});

describe('slugToPath — §6 row 15 resolution order', () => {
  const projects = [PATHS.plain, PATHS.dashed, PATHS.worktree];

  it('resolves through the ~/.claude.json projects keys first, even when the path holds dashes', () => {
    expect(slugToPath(SLUGS.dashed, projects)).toEqual({ path: PATHS.dashed, via: 'claude-json' });
    expect(slugToPath(SLUGS.worktree, projects)).toEqual({ path: PATHS.worktree, via: 'claude-json' });
    expect(slugToPath(SLUGS.plain, projects)).toEqual({ path: PATHS.plain, via: 'claude-json' });
  });

  it('falls back to a transcript record cwd when no project key matches', () => {
    expect(slugToPath(SLUGS.dashed, [], '/Users/x/elsewhere')).toEqual({ path: '/Users/x/elsewhere', via: 'transcript' });
  });

  it('is unmapped when neither knows it — the report asks the human to pick a path', () => {
    expect(slugToPath(SLUGS.dashed, [])).toEqual({ path: '', via: 'unmapped' });
    expect(slugToPath(SLUGS.dashed, [], null)).toEqual({ path: '', via: 'unmapped' });
    expect(slugToPath(SLUGS.dashed, [], '')).toEqual({ path: '', via: 'unmapped' });
    expect(slugToPath('', [])).toEqual({ path: '', via: 'unmapped' });
  });
});

describe('mergeWorktreeRoot — auto memory is derived from the repository', () => {
  it('a worktree slug merges into the repository root, with a notice saying so', () => {
    const m = mergeWorktreeRoot(PATHS.worktree);
    expect(m.merged).toBe(true);
    expect(m.root).toBe('/home/dev/projects/JevCode');
    expect(m.notice).toContain('is a worktree of');
    expect(m.notice).toContain('auto memory is merged into the repository root');
  });

  it('an ordinary repository path is unchanged and silent', () => {
    expect(mergeWorktreeRoot(PATHS.plain)).toEqual({ root: PATHS.plain, merged: false, notice: null });
  });

  it('two worktrees of one repository merge to the same root', () => {
    const a = mergeWorktreeRoot('/r/.claude/worktrees/one');
    const b = mergeWorktreeRoot('/r/.claude/worktrees/two');
    expect(a.root).toBe('/r');
    expect(b.root).toBe('/r');
  });
});
