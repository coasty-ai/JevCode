/**
 * import/sources.ts (IMPORT-DESIGN §3, §4.2.1; §6 rows 1–4 and the root half of row 85).
 *
 * §6 rows 1–4 are one table over `rootFor` rather than nine special cases, exactly as §3.1 asks.
 * Row 85's destination half (`slugOf`) is W2's; only the **root** half is here, so there is no
 * separate `windows-paths.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_EXCLUDED,
  OPT_IN_SOURCES,
  SOURCES,
  SOURCE_TOOLS,
  allRoots,
  displayRoot,
  expandBraces,
  globCanDescend,
  isAbsolutePath,
  matchGlob,
  rootFor,
  specById,
  specsForTool,
} from '../../../src/import/sources.js';
import type { SourceSpec } from '../../../src/import/types.js';

const HOME = '/Users/x';
const REPO = { workspace: '/Users/x/repo/pkg', gitRoot: '/Users/x/repo', extraRoots: [] as readonly string[] };

function spec(id: string): SourceSpec {
  const s = specById(id);
  if (s === undefined) throw new Error(`no atlas row ${id}`);
  return s;
}

function paths(id: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'darwin', home = HOME): string[] {
  return rootFor(spec(id), env, home, platform, REPO).map((r) => r.path);
}

describe('the atlas', () => {
  it('has unique ids, a destination for every row, and ~70 rows', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SOURCES.length).toBeGreaterThanOrEqual(60);
    for (const s of SOURCES) {
      expect(s.roots.length).toBeGreaterThan(0);
      expect(s.pattern.length).toBeGreaterThan(0);
      expect(SOURCE_TOOLS).toContain(s.tool);
      expect(s.destination.kind.length).toBeGreaterThan(0);
    }
  });

  it('every opt-in row names one of the four --source values (§4.2.6), and every transcript row is opt-in or reported', () => {
    for (const s of SOURCES) if (s.optIn !== undefined) expect(OPT_IN_SOURCES).toContain(s.optIn);
    for (const s of SOURCES.filter((r) => r.class === 'transcript')) expect(s.destination.kind).toBe('report-only');
  });

  it('covers all nine tools plus Claude Desktop, and specById / specsForTool find rows', () => {
    for (const tool of ['claude-code', 'codex', 'opencode', 'cursor', 'windsurf', 'aider', 'gemini', 'copilot', 'claude-desktop'] as const) {
      expect(specsForTool(tool).length).toBeGreaterThan(0);
    }
    expect(specById('claude.auto-memory.topic')?.pattern).toBe('projects/*/memory/**/*.md');
    expect(specById('nope')).toBeUndefined();
  });

  it('no secret row is ever destined anywhere but the report (§4.8)', () => {
    for (const s of SOURCES.filter((r) => r.class === 'secret')) expect(s.destination.kind).toBe('report-only');
  });

  it('§4.2.2: the always-exclusions include the load-bearing worktree and node_modules globs', () => {
    expect(ALWAYS_EXCLUDED).toContain('**/.claude/worktrees/**');
    expect(ALWAYS_EXCLUDED).toContain('**/node_modules/**');
    expect(ALWAYS_EXCLUDED).toContain('**/.jevcode/**');
  });
});

describe('rootFor — §6 rows 1–4, one table', () => {
  it.each([
    // row 1: every Claude root resolves under the override; ~/.claude is untouched
    ['claude.user-instructions', { CLAUDE_CONFIG_DIR: '/tmp/cc' }, ['/tmp/cc'], 'env', 'CLAUDE_CONFIG_DIR'],
    ['claude.user-instructions', {}, ['/Users/x/.claude'], 'default', undefined],
    // row 2: the same shape per tool, and the via column names the variable
    ['codex.config', { CODEX_HOME: '/tmp/codex' }, ['/tmp/codex'], 'env', 'CODEX_HOME'],
    ['codex.config', {}, ['/Users/x/.codex'], 'default', undefined],
    ['opencode.config.user', { XDG_CONFIG_HOME: '/tmp/xdg' }, ['/tmp/xdg/opencode'], 'env', 'XDG_CONFIG_HOME'],
    ['opencode.config.user', {}, ['/Users/x/.config/opencode'], 'default', undefined],
    ['opencode.auth', { XDG_DATA_HOME: '/tmp/data' }, ['/tmp/data/opencode'], 'env', 'XDG_DATA_HOME'],
    ['opencode.auth', {}, ['/Users/x/.local/share/opencode'], 'default', undefined],
    ['opencode.config.env', { OPENCODE_CONFIG: '/tmp/oc.json' }, ['/tmp/oc.json'], 'env', 'OPENCODE_CONFIG'],
    ['gemini.settings.system', { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/g.json' }, ['/tmp/g.json'], 'env', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH'],
    ['gemini.settings.system', {}, ['/Library/Application Support/GeminiCli/settings.json'], 'default', undefined],
  ] as const)('%s with %o', (id, env, expected, via, envName) => {
    const roots = rootFor(spec(id), env, HOME, 'darwin', REPO);
    expect(roots.map((r) => r.path)).toEqual(expected);
    expect(roots[0]?.via).toBe(via);
    expect(roots[0]?.env).toBe(envName);
  });

  it('row 1: an override does not leak into another tool, and ~/.claude is not scanned as well', () => {
    expect(paths('claude.rules.user', { CLAUDE_CONFIG_DIR: '/tmp/cc' })).toEqual(['/tmp/cc']);
    expect(paths('codex.config', { CLAUDE_CONFIG_DIR: '/tmp/cc' })).toEqual(['/Users/x/.codex']);
  });

  it('row 3: OPENCODE_DATA_DIR=/a,/b scans both, trimmed, absolute-only, deduped', () => {
    expect(paths('opencode.auth', { OPENCODE_DATA_DIR: '/a, /b' })).toEqual(['/a', '/b']);
    expect(paths('opencode.auth', { OPENCODE_DATA_DIR: '/a,/a' })).toEqual(['/a']);
    expect(paths('opencode.auth', { OPENCODE_DATA_DIR: '/a,relative,/b' })).toEqual(['/a', '/b']);
  });

  it('row 4: a relative XDG_CONFIG_HOME is ignored per spec and falls back to ~/.config', () => {
    const roots = rootFor(spec('opencode.config.user'), { XDG_CONFIG_HOME: '.config' }, HOME, 'darwin', REPO);
    expect(roots.map((r) => r.path)).toEqual(['/Users/x/.config/opencode']);
    expect(roots[0]?.via).toBe('default');
    expect(paths('claude.user-instructions', { CLAUDE_CONFIG_DIR: 'relative/cc' })).toEqual(['/Users/x/.claude']);
    expect(paths('claude.user-instructions', { CLAUDE_CONFIG_DIR: '' })).toEqual(['/Users/x/.claude']);
  });

  it('a `~/…` override is expanded against the given home, never process.env.HOME', () => {
    expect(paths('claude.user-instructions', { CLAUDE_CONFIG_DIR: '~/alt-claude' })).toEqual(['/Users/x/alt-claude']);
  });

  it('repo rows resolve to the workspace, the git root and every --from path, deduped', () => {
    const roots = rootFor(spec('claude.project-instructions'), {}, HOME, 'darwin', { workspace: '/w', gitRoot: '/w', extraRoots: ['/extra', '/w'] });
    expect(roots.map((r) => r.path)).toEqual(['/w', '/extra']);
    expect(roots.every((r) => r.kind === 'repo' && r.via === 'default')).toBe(true);
  });

  it('display is the ~/… form, and exists is never probed here', () => {
    const roots = rootFor(spec('claude.user-instructions'), {}, HOME, 'darwin', REPO);
    expect(roots[0]?.display).toBe('~/.claude');
    expect(roots[0]?.exists).toBe(false);
    expect(displayRoot('/Users/x', HOME)).toBe('~');
    expect(displayRoot('/other/p', HOME)).toBe('/other/p');
  });
});

describe('rootFor — §6 row 85, the root half (platform-stubbed)', () => {
  it('%USERPROFILE% and %APPDATA% resolve on win32', () => {
    const env = { USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
    expect(paths('claude-desktop.config', env, 'win32', 'C:\\Users\\x')).toEqual(['C:\\Users\\x\\AppData\\Roaming\\Claude']);
    expect(paths('claude.settings.managed', env, 'win32', 'C:\\Users\\x')).toEqual(['C:\\Users\\x\\AppData\\Roaming\\ClaudeCode']);
  });

  it('a drive-relative path (C:foo) is not absolute and is refused as a root; a UNC root is accepted', () => {
    expect(isAbsolutePath('C:foo', 'win32')).toBe(false);
    expect(isAbsolutePath('C:\\foo', 'win32')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share', 'win32')).toBe(true);
    expect(isAbsolutePath('/abs', 'darwin')).toBe(true);
    expect(isAbsolutePath('rel', 'darwin')).toBe(false);
    expect(paths('claude.user-instructions', { CLAUDE_CONFIG_DIR: 'C:foo' }, 'win32', 'C:\\Users\\x')).toEqual(['C:\\Users\\x\\.claude']);
    expect(paths('claude.user-instructions', { CLAUDE_CONFIG_DIR: '\\\\server\\share\\cc' }, 'win32', 'C:\\Users\\x')).toEqual(['\\\\server\\share\\cc']);
  });

  it('managed roots gated by their platform list do not appear on the wrong platform', () => {
    expect(paths('claude.settings.managed', {}, 'darwin')).toEqual(['/Library/Application Support/ClaudeCode']);
    expect(paths('claude.settings.managed', {}, 'linux')).toEqual(['/etc/claude-code']);
    expect(paths('claude.settings.managed', {}, 'win32', 'C:\\Users\\x')).toEqual([]);
    expect(paths('cursor.state', {}, 'linux')).toEqual([]);
    expect(paths('gemini.settings.system', {}, 'linux')).toEqual(['/etc/gemini-cli/settings.json']);
    expect(paths('gemini.settings.system', { APPDATA: 'C:\\A' }, 'win32', 'C:\\Users\\x')).toEqual(['C:\\ProgramData\\gemini-cli\\settings.json']);
  });

  it('a home root joins with the platform separator', () => {
    expect(paths('claude.user-instructions', {}, 'win32', 'C:\\Users\\x')).toEqual(['C:\\Users\\x\\.claude']);
    expect(displayRoot('C:\\Users\\x\\.claude', 'C:\\Users\\x')).toBe('~/.claude');
  });
});

describe('allRoots', () => {
  it('lists every root of every row once per tool, unprobed', () => {
    const roots = allRoots({ home: HOME, env: {}, platform: 'darwin', workspace: '/w', gitRoot: '/w', extraRoots: [] });
    const claude = roots.filter((r) => r.tool === 'claude-code').map((r) => r.path);
    expect(claude).toContain('/Users/x/.claude');
    expect(claude).toContain('/w');
    expect(new Set(claude).size).toBe(claude.length);
    expect(roots.every((r) => !r.exists)).toBe(true);
    // ~/.claude is claimed by both claude-code and opencode's compat row, and both are named
    expect(roots.filter((r) => r.path === '/Users/x/.claude').map((r) => r.tool)).toEqual(['claude-code', 'opencode']);
  });
});

describe('globs', () => {
  it('expandBraces', () => {
    expect(expandBraces('opencode.{json,jsonc}')).toEqual(['opencode.json', 'opencode.jsonc']);
    expect(expandBraces('a/{b,c}/{d,e}.md')).toEqual(['a/b/d.md', 'a/b/e.md', 'a/c/d.md', 'a/c/e.md']);
    expect(expandBraces('plain.md')).toEqual(['plain.md']);
  });

  it('matchGlob handles *, **, ? and case folding', () => {
    expect(matchGlob('CLAUDE.md', 'CLAUDE.md')).toBe(true);
    expect(matchGlob('CLAUDE.md', 'claude.md')).toBe(false);
    expect(matchGlob('CLAUDE.md', 'claude.md', true)).toBe(true);
    expect(matchGlob('rules/*.md', 'rules/a.md')).toBe(true);
    expect(matchGlob('rules/*.md', 'rules/nested/a.md')).toBe(false);
    expect(matchGlob('.claude/rules/**/*.md', '.claude/rules/a.md')).toBe(true);
    expect(matchGlob('.claude/rules/**/*.md', '.claude/rules/x/y/a.md')).toBe(true);
    expect(matchGlob('projects/*/memory/**/*.md', 'projects/slug/memory/MEMORY.md')).toBe(true);
    expect(matchGlob('**/AGENTS.md', 'AGENTS.md')).toBe(true);
    expect(matchGlob('**/AGENTS.md', 'pkg/a/AGENTS.md')).toBe(true);
    expect(matchGlob('.', '')).toBe(true);
    expect(matchGlob('.', 'x')).toBe(false);
  });

  it('globCanDescend prunes the walk: a directory is entered only when something under it can match', () => {
    expect(globCanDescend('projects/*/memory/**/*.md', 'projects')).toBe(true);
    expect(globCanDescend('projects/*/memory/**/*.md', 'projects/slug')).toBe(true);
    expect(globCanDescend('projects/*/memory/**/*.md', 'shell-snapshots')).toBe(false);
    expect(globCanDescend('CLAUDE.md', 'anything')).toBe(false);
    expect(globCanDescend('**/AGENTS.md', 'deep/nest')).toBe(true);
  });
});
