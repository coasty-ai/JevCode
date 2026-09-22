/**
 * docs/IMPORT-DESIGN.md §3 — the atlas, and `rootFor()`.
 *
 * One row of the atlas is one `SourceSpec`, and the atlas is **the only place a tool's knowledge
 * lives** (§3.1): a new tool is a block of rows here and nothing else. `rootFor` is pure and is
 * the only place an environment override is read, so §6 rows 1–4 are one table-driven test rather
 * than nine special cases. Nothing in this module touches disk — existence is probed by
 * `discover.ts`, which is the only module in `src/import/**` that performs I/O, and only through
 * the injected `ImportFs` seam.
 */
import { posix, win32 } from 'node:path';
import type { DestinationSpec, ImportClass, ImportEnvironment, ResolvedRoot, RootSpec, SourceFormat, SourceScope, SourceSpec, SourceTool } from './types.js';

// ---------------------------------------------------------------------------------------
// globs — shared with discover.ts (patterns are relative to their root, always `/`-separated)
// ---------------------------------------------------------------------------------------

/** `opencode.{json,jsonc}` → two patterns. Bounded: at most 64 expansions, then the pattern is used verbatim. */
export function expandBraces(pattern: string): readonly string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of pattern.slice(open + 1, close).split(',')) {
    for (const rest of expandBraces(`${head}${alt}${tail}`)) {
      if (out.length >= 64) return out;
      out.push(rest);
    }
  }
  return out;
}

function segmentRe(seg: string, caseInsensitive: boolean): RegExp {
  let src = '';
  for (const ch of seg) {
    if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, caseInsensitive ? 'i' : '');
}

function matchSegment(pattern: string, name: string, caseInsensitive: boolean): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return caseInsensitive ? pattern.toLowerCase() === name.toLowerCase() : pattern === name;
  return segmentRe(pattern, caseInsensitive).test(name);
}

/** The set of pattern positions still reachable after consuming `segs` — `**` matches zero or more segments. */
function reachable(pat: readonly string[], segs: readonly string[], caseInsensitive: boolean): Set<number> {
  const close = (s: Set<number>): Set<number> => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of [...s]) if (pat[p] === '**' && !s.has(p + 1)) (s.add(p + 1), (changed = true));
    }
    return s;
  };
  let cur = close(new Set<number>([0]));
  for (const seg of segs) {
    const next = new Set<number>();
    for (const p of cur) {
      const t = pat[p];
      if (t === undefined) continue;
      if (t === '**') next.add(p);
      else if (matchSegment(t, seg, caseInsensitive)) next.add(p + 1);
    }
    cur = close(next);
    if (cur.size === 0) break;
  }
  return cur;
}

function splitSegments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0 && s !== '.');
}

/** §4.2.2: does `rel` (a `/`-separated path relative to the root) match `pattern`? Brace-expanded, `**`-aware. */
export function matchGlob(pattern: string, rel: string, caseInsensitive = false): boolean {
  const segs = splitSegments(rel);
  for (const p of expandBraces(pattern)) {
    if (p === '.') {
      if (segs.length === 0) return true;
      continue;
    }
    if (reachable(splitSegments(p), segs, caseInsensitive).has(splitSegments(p).length)) return true;
  }
  return false;
}

/** True when something under the directory `rel` could still match `pattern` — the walk's pruning rule. */
export function globCanDescend(pattern: string, rel: string, caseInsensitive = false): boolean {
  const segs = splitSegments(rel);
  for (const p of expandBraces(pattern)) {
    if (p === '.') continue;
    const pat = splitSegments(p);
    for (const pos of reachable(pat, segs, caseInsensitive)) if (pos < pat.length) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// §4.2.1 roots
// ---------------------------------------------------------------------------------------

/** §4.2.2: excluded before any `stat`, always, even under `--all`. `.claude/worktrees` is load-bearing (§3.12). */
export const ALWAYS_EXCLUDED: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/target/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.claude/worktrees/**',
  '**/.jevcode/**',
  '**/.aider.tags.cache.v*/**',
  '**/skills/.system/**',
];

/** §4.2.6: the four `--source <id>` values that turn a transcript row from `skip:transcript` into a metadata pass. */
export const OPT_IN_SOURCES: readonly string[] = ['claude-transcripts', 'codex-sessions', 'opencode-sessions', 'aider-history'];

/** §3: every tool the atlas knows. */
export const SOURCE_TOOLS: readonly SourceTool[] = ['claude-code', 'claude-desktop', 'codex', 'opencode', 'cursor', 'windsurf', 'aider', 'gemini', 'copilot', 'mcp', 'pasted'];

/** §6 row 85: absolute on the **target** platform — `C:foo` is drive-relative and is not a root; `\\server\share` is. */
export function isAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
  if (p.length === 0) return false;
  if (platform !== 'win32') return p.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || /^[\\/]/.test(p);
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? (win32 as unknown as typeof posix) : posix;
}

function expandUser(p: string, home: string, platform: NodeJS.Platform): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return pathApi(platform).join(home, p.slice(2));
  return p;
}

/** `~/…` rendering — an artefact never carries an absolute home path (§4.2.5). */
export function displayRoot(path: string, home: string): string {
  if (home.length > 0 && path === home) return '~';
  if (home.length > 0 && (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) return `~/${path.slice(home.length + 1).split('\\').join('/')}`;
  return path;
}

/**
 * §4.2.5: the form every artefact shows — **workspace-relative inside the workspace**, `~/…`
 * outside it, absolute only when it is neither. This is `instructions.ts displayFor`'s rule,
 * and it is what makes the report read `AGENTS.md` and `.cursor/rules/style.mdc` rather than a
 * 70-character absolute path. It is also load-bearing for apply: `ApplyOptions.sourcePath`
 * resolves a row back to disk from `display`, so a display form the caller cannot invert makes
 * every row fail its re-read. Separators are normalised to `/` for display (§6 row 85).
 */
export function displayIn(path: string, workspace: string, home: string): string {
  if (workspace.length > 0 && (path.startsWith(`${workspace}/`) || path.startsWith(`${workspace}\\`))) {
    return path.slice(workspace.length + 1).split('\\').join('/');
  }
  return displayRoot(path, home);
}

interface TokenExpansion {
  path: string;
  via: 'default' | 'env';
  env?: string;
}

/**
 * §4.2.1: the default path of a root, with its `<xdgConfig>` / `<xdgData>` / `<appData>` /
 * `<userProfile>` tokens resolved. A **relative** `XDG_CONFIG_HOME` is ignored per spec (§6 row 4),
 * the rule `xdgConfigHome` (`credentials.ts:60`) already implements.
 */
function expandDefault(raw: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): TokenExpansion | null {
  const P = pathApi(platform);
  const token = /^<([A-Za-z]+)>/.exec(raw);
  if (token === null) {
    const p = expandUser(raw, home, platform);
    return isAbsolutePath(p, platform) ? { path: p, via: 'default' } : null;
  }
  const rest = raw.slice(token[0].length).replace(/^\//, '');
  const byToken: Readonly<Record<string, { name: string; fallback: string | null }>> = {
    xdgConfig: { name: 'XDG_CONFIG_HOME', fallback: P.join(home, '.config') },
    xdgData: { name: 'XDG_DATA_HOME', fallback: P.join(home, '.local', 'share') },
    appData: { name: 'APPDATA', fallback: null },
    userProfile: { name: 'USERPROFILE', fallback: home },
  };
  const t = byToken[token[1]!];
  if (t === undefined) return null;
  const fromEnv = env[t.name];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const p = expandUser(fromEnv, home, platform);
    if (isAbsolutePath(p, platform)) return { path: rest.length > 0 ? P.join(p, rest) : p, via: 'env', env: t.name };
  }
  if (t.fallback === null) return null;
  return { path: rest.length > 0 ? P.join(t.fallback, rest) : t.fallback, via: 'default' };
}

/** An `envOverride` entry is `NAME` or `NAME:file` — the latter names a file, and its row's pattern is `.`. */
function overrideName(entry: string): { name: string; file: boolean } {
  const [name, mode] = entry.split(':');
  return { name: name ?? entry, file: mode === 'file' };
}

/**
 * §3.1 / §6 rows 1–4: resolve one atlas row's roots on this machine. **Pure**, and the only place
 * an environment override is read: the override is checked before the default, in the order
 * declared; `OPENCODE_DATA_DIR` is comma-split; a relative or empty value is ignored; a root whose
 * `platform` list excludes `platform` does not appear at all. `exists` is never probed here.
 */
export function rootFor(
  spec: SourceSpec,
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  repo: { workspace: string; gitRoot: string | null; extraRoots?: readonly string[] },
): readonly ResolvedRoot[] {
  const out: ResolvedRoot[] = [];
  const seen = new Set<string>();
  const push = (path: string, kind: RootSpec['kind'], via: 'default' | 'env', envName?: string): void => {
    if (path.length === 0 || seen.has(path)) return;
    seen.add(path);
    out.push({ tool: spec.tool, kind, path, display: displayRoot(path, home), via, exists: false, ...(envName !== undefined ? { env: envName } : {}) });
  };
  for (const r of spec.roots) {
    if (r.platform !== undefined && !r.platform.includes(platform)) continue;
    if (r.kind === 'repo') {
      for (const p of [repo.workspace, repo.gitRoot, ...(repo.extraRoots ?? [])]) if (p !== null && p.length > 0) push(p, 'repo', 'default');
      continue;
    }
    let fired = false;
    for (const entry of r.envOverride ?? []) {
      const { name } = overrideName(entry);
      const raw = env[name];
      if (raw === undefined || raw.length === 0) continue;
      for (const part of r.splitOnComma === true ? raw.split(',') : [raw]) {
        const p = expandUser(part.trim(), home, platform);
        if (!isAbsolutePath(p, platform)) continue;
        push(p, r.kind, 'env', name);
        fired = true;
      }
      if (fired) break;
    }
    if (fired) continue;
    const def = expandDefault(r.path, env, home, platform);
    if (def !== null) push(def.path, r.kind, def.via, def.env);
  }
  return out;
}

/** §4.2.1: every root of every atlas row on this machine, deduped by tool + path. Existence is not probed. */
export function allRoots(e: Omit<ImportEnvironment, 'home'> & { home: string }): readonly ResolvedRoot[] {
  const out: ResolvedRoot[] = [];
  const seen = new Set<string>();
  for (const spec of SOURCES) {
    for (const root of rootFor(spec, e.env, e.home, e.platform, { workspace: e.workspace, gitRoot: e.gitRoot, extraRoots: e.extraRoots })) {
      const key = `${root.tool}\u0000${root.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(root);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// §3.2–§3.11 the atlas
// ---------------------------------------------------------------------------------------

const CLAUDE: RootSpec = { kind: 'home', envOverride: ['CLAUDE_CONFIG_DIR'], path: '~/.claude' };
const HOME: RootSpec = { kind: 'home', path: '~' };
const CODEX: RootSpec = { kind: 'home', envOverride: ['CODEX_HOME'], path: '~/.codex' };
const OPENCODE_CONFIG: RootSpec = { kind: 'home', path: '<xdgConfig>/opencode' };
const OPENCODE_DATA: RootSpec = { kind: 'home', envOverride: ['OPENCODE_DATA_DIR'], path: '<xdgData>/opencode', splitOnComma: true };
const CURSOR: RootSpec = { kind: 'home', path: '~/.cursor' };
const WINDSURF: RootSpec = { kind: 'home', path: '~/.codeium/windsurf' };
const GEMINI: RootSpec = { kind: 'home', path: '~/.gemini' };
const COPILOT: RootSpec = { kind: 'home', path: '~/.copilot' };
const REPO: RootSpec = { kind: 'repo', path: '<repo>' };
const CLAUDE_MANAGED: readonly RootSpec[] = [
  { kind: 'managed', path: '/Library/Application Support/ClaudeCode', platform: ['darwin'] },
  { kind: 'managed', path: '/etc/claude-code', platform: ['linux'] },
  { kind: 'managed', path: '<appData>/ClaudeCode', platform: ['win32'] },
];
const CLAUDE_DESKTOP: readonly RootSpec[] = [
  { kind: 'home', path: '~/Library/Application Support/Claude', platform: ['darwin'] },
  { kind: 'home', path: '<appData>/Claude', platform: ['win32'] },
  { kind: 'home', path: '<xdgConfig>/Claude', platform: ['linux'] },
];
const OPENCODE_MANAGED: readonly RootSpec[] = [
  { kind: 'managed', path: '/Library/Application Support/opencode', platform: ['darwin'] },
  { kind: 'managed', path: '/etc/opencode', platform: ['linux'] },
];
const GEMINI_SYSTEM: readonly RootSpec[] = [
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_SETTINGS_PATH:file'], path: '/Library/Application Support/GeminiCli/settings.json', platform: ['darwin'] },
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_SETTINGS_PATH:file'], path: '/etc/gemini-cli/settings.json', platform: ['linux'] },
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_SETTINGS_PATH:file'], path: 'C:\\ProgramData\\gemini-cli\\settings.json', platform: ['win32'] },
];
const GEMINI_DEFAULTS: readonly RootSpec[] = [
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_DEFAULTS_PATH:file'], path: '/Library/Application Support/GeminiCli/system-defaults.json', platform: ['darwin'] },
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_DEFAULTS_PATH:file'], path: '/etc/gemini-cli/system-defaults.json', platform: ['linux'] },
  { kind: 'managed', envOverride: ['GEMINI_CLI_SYSTEM_DEFAULTS_PATH:file'], path: 'C:\\ProgramData\\gemini-cli\\system-defaults.json', platform: ['win32'] },
];
/** §3.4: `$OPENCODE_CONFIG` names a config **file**; its row's pattern is `.` (the root is the artefact). */
const OPENCODE_CONFIG_FILE: RootSpec = { kind: 'home', envOverride: ['OPENCODE_CONFIG:file'], path: '' };

interface Row {
  id: string;
  tool: SourceTool;
  artefact: string;
  roots: readonly RootSpec[];
  pattern: string;
  format: SourceFormat;
  class: ImportClass;
  scope: SourceScope;
  dest: DestinationSpec['kind'];
  destScope?: DestinationSpec['scope'];
  precedence?: number;
  notes?: readonly string[];
  optIn?: string;
}

function row(r: Row): SourceSpec {
  return {
    id: r.id,
    tool: r.tool,
    artefact: r.artefact,
    roots: r.roots,
    pattern: r.pattern,
    format: r.format,
    class: r.class,
    scope: r.scope,
    destination: { kind: r.dest, scope: r.destScope ?? (r.scope === 'managed' ? 'user' : r.scope) },
    ...(r.precedence !== undefined ? { precedence: r.precedence } : {}),
    ...(r.notes !== undefined ? { notes: r.notes } : {}),
    ...(r.optIn !== undefined ? { optIn: r.optIn } : {}),
  };
}

/**
 * §3.2–§3.11: the atlas. Order matters twice: `precedence` picks a winner inside one tool's chain
 * ("first match wins"), and the **row order** decides which row names an artefact that five
 * detectors all find — the realpath stays one `SourceItem` with five `tools` (§4.2.3).
 */
export const SOURCES: readonly SourceSpec[] = [
  // ----- §3.2 Claude Code -----
  row({ id: 'claude.user-instructions', tool: 'claude-code', artefact: 'user instructions', roots: [CLAUDE], pattern: 'CLAUDE.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append' }),
  row({ id: 'claude.project-instructions', tool: 'claude-code', artefact: 'project instructions', roots: [REPO], pattern: 'CLAUDE.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append', precedence: 1 }),
  row({ id: 'claude.project-instructions.dot', tool: 'claude-code', artefact: 'project instructions (.claude)', roots: [REPO], pattern: '.claude/CLAUDE.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append', precedence: 2 }),
  row({ id: 'claude.project-instructions.nested', tool: 'claude-code', artefact: 'subdirectory instructions', roots: [REPO], pattern: '**/CLAUDE.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', precedence: 3 }),
  row({
    id: 'claude.agents-file',
    tool: 'claude-code',
    artefact: 'agents file',
    roots: [REPO],
    pattern: 'AGENTS.md',
    format: 'md',
    class: 'memory',
    scope: 'project',
    dest: 'agents-append',
    precedence: 4,
    notes: ['Claude Code reads AGENTS.md only when no CLAUDE.md exists; the importer takes both and reports the pair as a duplicate group (§3.2)'],
  }),
  row({ id: 'claude.project-local', tool: 'claude-code', artefact: 'personal (uncommitted) instructions', roots: [REPO], pattern: '**/CLAUDE.local.md', format: 'md', class: 'memory', scope: 'project-local', dest: 'memory-local' }),
  row({ id: 'claude.rules.user', tool: 'claude-code', artefact: 'user rules', roots: [CLAUDE], pattern: 'rules/*.md', format: 'md', class: 'rule', scope: 'user', dest: 'rule' }),
  row({ id: 'claude.rules.project', tool: 'claude-code', artefact: 'project rules', roots: [REPO], pattern: '.claude/rules/**/*.md', format: 'md', class: 'rule', scope: 'project', dest: 'rule' }),
  row({ id: 'claude.auto-memory.index', tool: 'claude-code', artefact: 'auto memory index', roots: [CLAUDE], pattern: 'projects/*/memory/MEMORY.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-index', precedence: 1 }),
  row({ id: 'claude.auto-memory.topic', tool: 'claude-code', artefact: 'auto memory topic', roots: [CLAUDE], pattern: 'projects/*/memory/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-topic', precedence: 2 }),
  row({ id: 'claude.agent-memory.user', tool: 'claude-code', artefact: 'agent memory', roots: [CLAUDE], pattern: 'agent-memory/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-topic' }),
  row({ id: 'claude.agent-memory.project', tool: 'claude-code', artefact: 'agent memory (project)', roots: [REPO], pattern: '.claude/agent-memory/**/*.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic' }),
  row({ id: 'claude.agent-memory.local', tool: 'claude-code', artefact: 'agent memory (local)', roots: [REPO], pattern: '.claude/agent-memory-local/**/*.md', format: 'md', class: 'memory', scope: 'project-local', dest: 'memory-local' }),
  row({ id: 'claude.skills.user', tool: 'claude-code', artefact: 'skills', roots: [CLAUDE], pattern: 'skills/*/SKILL.md', format: 'md', class: 'command', scope: 'user', dest: 'command', notes: ['supporting files are listed, not copied'] }),
  row({ id: 'claude.skills.project', tool: 'claude-code', artefact: 'project skills', roots: [REPO], pattern: '**/.claude/skills/*/SKILL.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'claude.commands.user', tool: 'claude-code', artefact: 'legacy commands', roots: [CLAUDE], pattern: 'commands/**/*.md', format: 'md', class: 'command', scope: 'user', dest: 'command', notes: ['a skill of the same name wins'] }),
  row({ id: 'claude.commands.project', tool: 'claude-code', artefact: 'project commands', roots: [REPO], pattern: '.claude/commands/**/*.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'claude.subagents.user', tool: 'claude-code', artefact: 'subagents', roots: [CLAUDE], pattern: 'agents/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-topic', notes: ['JevCode has no subagent surface; imported as a reference note'] }),
  row({ id: 'claude.subagents.project', tool: 'claude-code', artefact: 'project subagents', roots: [REPO], pattern: '.claude/agents/**/*.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', notes: ['JevCode has no subagent surface; imported as a reference note'] }),
  row({ id: 'claude.workflows.user', tool: 'claude-code', artefact: 'saved workflows', roots: [CLAUDE], pattern: 'workflows/*.js', format: 'js', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:unsupported — a .js workflow is never executed; meta.name / meta.description are reported'] }),
  row({ id: 'claude.workflows.project', tool: 'claude-code', artefact: 'project workflows', roots: [REPO], pattern: '.claude/workflows/*.js', format: 'js', class: 'skip', scope: 'project', dest: 'report-only', notes: ['skip:unsupported — a .js workflow is never executed'] }),
  row({ id: 'claude.settings.user', tool: 'claude-code', artefact: 'settings', roots: [CLAUDE], pattern: 'settings.json', format: 'json', class: 'config', scope: 'user', dest: 'report-only' }),
  row({ id: 'claude.settings.project', tool: 'claude-code', artefact: 'project settings', roots: [REPO], pattern: '.claude/settings.json', format: 'json', class: 'config', scope: 'project', dest: 'report-only' }),
  row({ id: 'claude.settings.local', tool: 'claude-code', artefact: 'local settings', roots: [REPO], pattern: '.claude/settings.local.json', format: 'json', class: 'config', scope: 'project-local', dest: 'report-only' }),
  row({ id: 'claude.settings.managed', tool: 'claude-code', artefact: 'managed settings', roots: CLAUDE_MANAGED, pattern: 'managed-settings.json', format: 'json', class: 'config', scope: 'managed', dest: 'report-only' }),
  row({ id: 'claude.global-config', tool: 'claude-code', artefact: 'global config', roots: [HOME], pattern: '.claude.json', format: 'json', class: 'config', scope: 'user', dest: 'mcp', destScope: 'user', notes: ['mcpServers → mcp.json; oauthAccount is named, never read'] }),
  row({ id: 'claude.project-mcp', tool: 'claude-code', artefact: 'project MCP', roots: [REPO], pattern: '.mcp.json', format: 'json', class: 'mcp', scope: 'project', dest: 'mcp' }),
  row({ id: 'claude.credentials', tool: 'claude-code', artefact: 'credentials', roots: [CLAUDE], pattern: '.credentials.json', format: 'json', class: 'secret', scope: 'user', dest: 'report-only', notes: ['named, never read'] }),
  row({ id: 'claude.session-keys', tool: 'claude-code', artefact: 'session keys', roots: [CLAUDE], pattern: 'sessions/*.key', format: 'text', class: 'secret', scope: 'user', dest: 'report-only', notes: ['named, never read'] }),
  row({ id: 'claude.transcripts', tool: 'claude-code', artefact: 'transcripts', roots: [CLAUDE], pattern: 'projects/*/*.jsonl', format: 'jsonl', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'claude-transcripts' }),
  row({ id: 'claude.transcripts.nested', tool: 'claude-code', artefact: 'sub-agent and tool transcripts', roots: [CLAUDE], pattern: 'projects/*/*/**/*.jsonl', format: 'jsonl', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'claude-transcripts', notes: ['bodies, tool results and sub-agent transcripts are never read'] }),
  row({ id: 'claude.history', tool: 'claude-code', artefact: 'prompt history', roots: [CLAUDE], pattern: 'history.jsonl', format: 'jsonl', class: 'skip', scope: 'user', dest: 'report-only', notes: ['never imported'] }),
  row({ id: 'claude.shell-snapshots', tool: 'claude-code', artefact: 'shell snapshots', roots: [CLAUDE], pattern: 'shell-snapshots/*.sh', format: 'sh', class: 'skip', scope: 'user', dest: 'report-only', notes: ['never imported (environment dumps)'] }),
  row({ id: 'claude.plugins', tool: 'claude-code', artefact: 'installed plugins', roots: [CLAUDE], pattern: 'plugins/installed_plugins.json', format: 'json', class: 'config', scope: 'user', dest: 'report-only', notes: ['names and versions only'] }),
  row({ id: 'claude.plugins.manifest', tool: 'claude-code', artefact: 'plugin manifests', roots: [CLAUDE], pattern: 'plugins/cache/*/.claude-plugin/plugin.json', format: 'json', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:third-party'] }),
  row({ id: 'claude.keybindings', tool: 'claude-code', artefact: 'keybindings', roots: [CLAUDE], pattern: 'keybindings.json', format: 'json', class: 'config', scope: 'user', dest: 'report-only', notes: ['offered as a keybindings.json merge; unmapped actions are reported'] }),

  // ----- §3.3 Codex -----
  row({ id: 'codex.global-instructions.override', tool: 'codex', artefact: 'global instructions (override)', roots: [CODEX], pattern: 'AGENTS.override.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append', precedence: 1 }),
  row({ id: 'codex.global-instructions', tool: 'codex', artefact: 'global instructions', roots: [CODEX], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append', precedence: 2 }),
  row({ id: 'codex.project-instructions.override', tool: 'codex', artefact: 'project instructions (override)', roots: [REPO], pattern: 'AGENTS.override.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append', precedence: 1 }),
  row({ id: 'codex.project-instructions', tool: 'codex', artefact: 'project instructions', roots: [REPO], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append', precedence: 2 }),
  row({ id: 'codex.project-instructions.nested', tool: 'codex', artefact: 'subdirectory instructions', roots: [REPO], pattern: '**/AGENTS.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', precedence: 3 }),
  row({ id: 'codex.memories', tool: 'codex', artefact: 'memories', roots: [CODEX], pattern: 'memories/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-topic', notes: ['only present when [features] memories = true'] }),
  row({ id: 'codex.prompts', tool: 'codex', artefact: 'prompts', roots: [CODEX], pattern: 'prompts/*.md', format: 'md', class: 'command', scope: 'user', dest: 'command' }),
  row({ id: 'codex.skills.user', tool: 'codex', artefact: 'skills', roots: [CODEX], pattern: 'skills/*/SKILL.md', format: 'md', class: 'command', scope: 'user', dest: 'command', notes: ['skills/.system/** is never read'] }),
  row({ id: 'codex.skills.project', tool: 'codex', artefact: 'project skills', roots: [REPO], pattern: '.codex/skills/*/SKILL.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'codex.skills.agents-dir', tool: 'codex', artefact: 'project skills (.agents)', roots: [REPO], pattern: '.agents/skills/*/SKILL.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'codex.rules', tool: 'codex', artefact: 'approval rules', roots: [CODEX], pattern: 'rules/*.rules', format: 'text', class: 'config', scope: 'user', dest: 'report-only', notes: ['rendered under ## Suggested permissions (not applied)'] }),
  row({ id: 'codex.config', tool: 'codex', artefact: 'config', roots: [CODEX], pattern: 'config.toml', format: 'toml', class: 'config', scope: 'user', dest: 'report-only', notes: ['[mcp_servers.*] → mcp.json; [projects."<p>"] trust_level → a suggestion'] }),
  row({ id: 'codex.auth', tool: 'codex', artefact: 'auth', roots: [CODEX], pattern: 'auth.json', format: 'json', class: 'secret', scope: 'user', dest: 'report-only', notes: ['named, never read'] }),
  row({ id: 'codex.sessions', tool: 'codex', artefact: 'session rollouts', roots: [CODEX], pattern: 'sessions/**/rollout-*.jsonl', format: 'jsonl', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'codex-sessions' }),
  row({ id: 'codex.archived-sessions', tool: 'codex', artefact: 'archived sessions', roots: [CODEX], pattern: 'archived_sessions/**/*.jsonl', format: 'jsonl', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'codex-sessions' }),
  row({ id: 'codex.session-index', tool: 'codex', artefact: 'session index', roots: [CODEX], pattern: 'session_index.jsonl', format: 'jsonl', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'codex-sessions' }),
  row({ id: 'codex.sqlite', tool: 'codex', artefact: 'state databases', roots: [CODEX], pattern: '*.sqlite', format: 'sqlite', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:unsupported — sqlite (no reader)'] }),

  // ----- §3.4 opencode -----
  row({ id: 'opencode.rules.user', tool: 'opencode', artefact: 'user rules', roots: [OPENCODE_CONFIG], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append' }),
  row({ id: 'opencode.rules.project', tool: 'opencode', artefact: 'project rules', roots: [REPO], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append' }),
  row({ id: 'opencode.rules.claude-compat', tool: 'opencode', artefact: 'Claude-compat rules', roots: [CLAUDE], pattern: 'CLAUDE.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append', notes: ['the same realpath Claude Code reads (§4.2.3)'] }),
  row({ id: 'opencode.agents.user', tool: 'opencode', artefact: 'agents', roots: [OPENCODE_CONFIG], pattern: '{agents,agent}/*.md', format: 'md', class: 'command', scope: 'user', dest: 'command' }),
  row({ id: 'opencode.agents.project', tool: 'opencode', artefact: 'project agents', roots: [REPO], pattern: '.opencode/{agents,agent}/*.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'opencode.commands.user', tool: 'opencode', artefact: 'commands', roots: [OPENCODE_CONFIG], pattern: '{commands,command}/*.md', format: 'md', class: 'command', scope: 'user', dest: 'command' }),
  row({ id: 'opencode.commands.project', tool: 'opencode', artefact: 'project commands', roots: [REPO], pattern: '.opencode/{commands,command}/*.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'opencode.skills.user', tool: 'opencode', artefact: 'skills', roots: [OPENCODE_CONFIG], pattern: 'skills/*/SKILL.md', format: 'md', class: 'command', scope: 'user', dest: 'command' }),
  row({ id: 'opencode.skills.project', tool: 'opencode', artefact: 'project skills', roots: [REPO], pattern: '.opencode/skills/*/SKILL.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'opencode.config.user', tool: 'opencode', artefact: 'config', roots: [OPENCODE_CONFIG], pattern: 'opencode.{json,jsonc}', format: 'jsonc', class: 'config', scope: 'user', dest: 'report-only', notes: ['mcp, permission, keybinds, model'] }),
  row({ id: 'opencode.config.project', tool: 'opencode', artefact: 'project config', roots: [REPO], pattern: 'opencode.{json,jsonc}', format: 'jsonc', class: 'config', scope: 'project', dest: 'report-only' }),
  row({ id: 'opencode.config.env', tool: 'opencode', artefact: 'config ($OPENCODE_CONFIG)', roots: [OPENCODE_CONFIG_FILE], pattern: '.', format: 'jsonc', class: 'config', scope: 'user', dest: 'report-only' }),
  row({ id: 'opencode.config.managed', tool: 'opencode', artefact: 'managed config', roots: OPENCODE_MANAGED, pattern: 'opencode.{json,jsonc}', format: 'jsonc', class: 'config', scope: 'managed', dest: 'report-only' }),
  row({ id: 'opencode.auth', tool: 'opencode', artefact: 'auth', roots: [OPENCODE_DATA], pattern: 'auth.json', format: 'json', class: 'secret', scope: 'user', dest: 'report-only', notes: ['named, never read'] }),
  row({ id: 'opencode.sessions', tool: 'opencode', artefact: 'sessions', roots: [OPENCODE_DATA], pattern: 'storage/session/**/*.json', format: 'json', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'opencode-sessions' }),
  row({ id: 'opencode.messages', tool: 'opencode', artefact: 'messages', roots: [OPENCODE_DATA], pattern: 'storage/message/**/*.json', format: 'json', class: 'transcript', scope: 'user', dest: 'report-only', optIn: 'opencode-sessions' }),
  row({ id: 'opencode.db', tool: 'opencode', artefact: 'session database', roots: [OPENCODE_DATA], pattern: 'opencode.db', format: 'sqlite', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:unsupported — sqlite (no reader)'] }),

  // ----- §3.5 Cursor -----
  row({ id: 'cursor.rules', tool: 'cursor', artefact: 'rules', roots: [REPO], pattern: '.cursor/rules/**/*.mdc', format: 'mdc', class: 'rule', scope: 'project', dest: 'rule' }),
  row({ id: 'cursor.legacy-rules', tool: 'cursor', artefact: 'legacy rules', roots: [REPO], pattern: '.cursorrules', format: 'text', class: 'rule', scope: 'project', dest: 'rule', notes: ['deprecated by Cursor; imported as an always-on rule'] }),
  row({ id: 'cursor.agents', tool: 'cursor', artefact: 'agents file', roots: [REPO], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append' }),
  row({ id: 'cursor.mcp.project', tool: 'cursor', artefact: 'project MCP', roots: [REPO], pattern: '.cursor/mcp.json', format: 'json', class: 'mcp', scope: 'project', dest: 'mcp' }),
  row({ id: 'cursor.mcp.user', tool: 'cursor', artefact: 'MCP', roots: [CURSOR], pattern: 'mcp.json', format: 'json', class: 'mcp', scope: 'user', dest: 'mcp' }),
  row({ id: 'cursor.state', tool: 'cursor', artefact: 'chat history', roots: [{ kind: 'home', path: '~/Library/Application Support/Cursor/User', platform: ['darwin'] }], pattern: '{globalStorage,workspaceStorage/*}/state.vscdb', format: 'sqlite', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:unsupported — sqlite (no reader); User Rules live on the Cursor account (§3.11)'] }),

  // ----- §3.6 Windsurf / Devin -----
  row({ id: 'windsurf.global-rules', tool: 'windsurf', artefact: 'global rules', roots: [WINDSURF], pattern: 'memories/global_rules.md', format: 'md', class: 'rule', scope: 'user', dest: 'rule', precedence: 1, notes: ['always-on; the source limit is 6 000 characters'] }),
  row({ id: 'windsurf.cascade-memories', tool: 'windsurf', artefact: 'Cascade memories', roots: [WINDSURF], pattern: 'memories/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'memory-topic', precedence: 2, notes: ['undocumented format: best-effort, else skip:unknown-format (§3.11)'] }),
  row({ id: 'windsurf.workspace-rules', tool: 'windsurf', artefact: 'workspace rules', roots: [REPO], pattern: '.devin/rules/*.md', format: 'md', class: 'rule', scope: 'project', dest: 'rule', precedence: 1, notes: ['12 000-character source limit → clipped to ruleBytes with a notice'] }),
  row({ id: 'windsurf.workspace-rules.legacy', tool: 'windsurf', artefact: 'workspace rules (legacy)', roots: [REPO], pattern: '.windsurf/rules/*.md', format: 'md', class: 'rule', scope: 'project', dest: 'rule', precedence: 2 }),
  row({ id: 'windsurf.legacy-rules', tool: 'windsurf', artefact: 'legacy rules', roots: [REPO], pattern: '.windsurfrules', format: 'text', class: 'rule', scope: 'project', dest: 'rule' }),
  row({ id: 'windsurf.workflows', tool: 'windsurf', artefact: 'workflows', roots: [REPO], pattern: '.windsurf/workflows/*.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'windsurf.mcp', tool: 'windsurf', artefact: 'MCP', roots: [WINDSURF], pattern: 'mcp_config.json', format: 'json', class: 'mcp', scope: 'user', dest: 'mcp', notes: ['serverUrl, not url (§3.10)'] }),

  // ----- §3.7 Aider -----
  row({ id: 'aider.conventions', tool: 'aider', artefact: 'conventions', roots: [REPO], pattern: 'CONVENTIONS.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', notes: ['the read: list in .aider.conf.yml is the real source of truth'] }),
  row({ id: 'aider.config.repo', tool: 'aider', artefact: 'config', roots: [REPO], pattern: '.aider.conf.yml', format: 'yaml', class: 'config', scope: 'project', dest: 'report-only' }),
  row({ id: 'aider.config.home', tool: 'aider', artefact: 'config (home)', roots: [HOME], pattern: '.aider.conf.yml', format: 'yaml', class: 'config', scope: 'user', dest: 'report-only' }),
  row({ id: 'aider.model-settings', tool: 'aider', artefact: 'model settings', roots: [REPO], pattern: '.aider.model.{settings.yml,metadata.json}', format: 'yaml', class: 'config', scope: 'project', dest: 'report-only', notes: ['reported, not mapped (no JevCode equivalent)'] }),
  row({ id: 'aider.env.repo', tool: 'aider', artefact: '.env', roots: [REPO], pattern: '.env', format: 'text', class: 'secret', scope: 'project', dest: 'report-only', notes: ['names and counts only; never read for content'] }),
  row({ id: 'aider.env.home', tool: 'aider', artefact: '.env (home)', roots: [HOME], pattern: '.env', format: 'text', class: 'secret', scope: 'user', dest: 'report-only', notes: ['names and counts only; never read for content'] }),
  row({ id: 'aider.history.chat', tool: 'aider', artefact: 'chat history', roots: [REPO], pattern: '.aider.chat.history.md', format: 'md', class: 'transcript', scope: 'project', dest: 'report-only', optIn: 'aider-history' }),
  row({ id: 'aider.history.input', tool: 'aider', artefact: 'input history', roots: [REPO], pattern: '{.aider.input.history,.llm-history-file}', format: 'text', class: 'transcript', scope: 'project', dest: 'report-only', optIn: 'aider-history' }),

  // ----- §3.8 Gemini CLI -----
  row({ id: 'gemini.context.user', tool: 'gemini', artefact: 'context file', roots: [GEMINI], pattern: 'GEMINI.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append' }),
  row({ id: 'gemini.context.project', tool: 'gemini', artefact: 'project context file', roots: [REPO], pattern: 'GEMINI.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append', precedence: 1 }),
  row({ id: 'gemini.context.nested', tool: 'gemini', artefact: 'subdirectory context files', roots: [REPO], pattern: '**/{GEMINI.md,CONTEXT.md}', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', precedence: 2, notes: ['the names come from context.fileName; the default set is globbed when it is absent (§6 row 6a)'] }),
  row({ id: 'gemini.commands.user', tool: 'gemini', artefact: 'commands', roots: [GEMINI], pattern: 'commands/**/*.toml', format: 'toml', class: 'command', scope: 'user', dest: 'command', notes: ['dir/ → /dir:name; prompt required, {{args}} kept, !{shell} fenced'] }),
  row({ id: 'gemini.commands.project', tool: 'gemini', artefact: 'project commands', roots: [REPO], pattern: '.gemini/commands/**/*.toml', format: 'toml', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'gemini.settings.user', tool: 'gemini', artefact: 'settings', roots: [GEMINI], pattern: 'settings.json', format: 'jsonc', class: 'config', scope: 'user', dest: 'report-only' }),
  row({ id: 'gemini.settings.project', tool: 'gemini', artefact: 'project settings', roots: [REPO], pattern: '.gemini/settings.json', format: 'jsonc', class: 'config', scope: 'project', dest: 'report-only' }),
  row({ id: 'gemini.settings.system', tool: 'gemini', artefact: 'system settings', roots: GEMINI_SYSTEM, pattern: '.', format: 'jsonc', class: 'config', scope: 'managed', dest: 'report-only' }),
  row({ id: 'gemini.settings.defaults', tool: 'gemini', artefact: 'system defaults', roots: GEMINI_DEFAULTS, pattern: '.', format: 'jsonc', class: 'config', scope: 'managed', dest: 'report-only' }),
  row({ id: 'gemini.secrets.oauth', tool: 'gemini', artefact: 'MCP OAuth tokens', roots: [GEMINI], pattern: 'mcp-oauth-tokens.json', format: 'json', class: 'secret', scope: 'user', dest: 'report-only', notes: ['named, never read'] }),
  row({ id: 'gemini.env.user', tool: 'gemini', artefact: '.env', roots: [GEMINI], pattern: '.env', format: 'text', class: 'secret', scope: 'user', dest: 'report-only', notes: ['names and counts only'] }),
  row({ id: 'gemini.env.project', tool: 'gemini', artefact: 'project .env', roots: [REPO], pattern: '.gemini/.env', format: 'text', class: 'secret', scope: 'project', dest: 'report-only', notes: ['names and counts only'] }),
  row({ id: 'gemini.checkpoints', tool: 'gemini', artefact: 'checkpoints', roots: [GEMINI], pattern: 'tmp/*/checkpoints/**/*', format: 'json', class: 'transcript', scope: 'user', dest: 'report-only' }),
  row({ id: 'gemini.ignore', tool: 'gemini', artefact: 'ignore file', roots: [REPO], pattern: '.geminiignore', format: 'text', class: 'config', scope: 'project', dest: 'report-only', notes: ['reported; JevCode has its own ignore rules'] }),

  // ----- §3.9 GitHub Copilot / VS Code -----
  row({ id: 'copilot.repo-instructions', tool: 'copilot', artefact: 'repository instructions', roots: [REPO], pattern: '.github/copilot-instructions.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append' }),
  row({ id: 'copilot.scoped-instructions', tool: 'copilot', artefact: 'scoped instructions', roots: [REPO], pattern: '.github/instructions/*.instructions.md', format: 'md', class: 'rule', scope: 'project', dest: 'rule', notes: ['applyTo is comma-separated globs'] }),
  row({ id: 'copilot.user-instructions', tool: 'copilot', artefact: 'user instructions', roots: [COPILOT], pattern: 'instructions/**/*.md', format: 'md', class: 'memory', scope: 'user', dest: 'agents-append' }),
  row({ id: 'copilot.agents', tool: 'copilot', artefact: 'agents file', roots: [REPO], pattern: 'AGENTS.md', format: 'md', class: 'memory', scope: 'project', dest: 'agents-append' }),
  row({ id: 'copilot.prompts', tool: 'copilot', artefact: 'prompts', roots: [REPO], pattern: '.github/prompts/*.prompt.md', format: 'md', class: 'command', scope: 'project', dest: 'command' }),
  row({ id: 'copilot.agent-files', tool: 'copilot', artefact: 'agents', roots: [REPO], pattern: '.github/agents/*.agent.md', format: 'md', class: 'memory', scope: 'project', dest: 'memory-topic', notes: ['JevCode has no subagent surface; imported as a reference note'] }),
  row({ id: 'copilot.mcp', tool: 'copilot', artefact: 'MCP', roots: [REPO], pattern: '.vscode/mcp.json', format: 'jsonc', class: 'mcp', scope: 'project', dest: 'mcp', notes: ['servers, inputs[], envFile; ${input:id} → ${ID_UPPER} with a note'] }),
  row({ id: 'copilot.config', tool: 'copilot', artefact: 'tool config', roots: [COPILOT], pattern: 'config.json', format: 'jsonc', class: 'skip', scope: 'user', dest: 'report-only', notes: ['skip:tool-managed — "managed automatically"'] }),

  // ----- §3.10 Claude Desktop -----
  row({ id: 'claude-desktop.config', tool: 'claude-desktop', artefact: 'desktop config', roots: CLAUDE_DESKTOP, pattern: 'claude_desktop_config.json', format: 'json', class: 'mcp', scope: 'user', dest: 'mcp', notes: ['no expansion syntax at all: every env value is a literal (§3.10)'] }),
];

/** §3.1: one atlas row by id. */
export function specById(id: string): SourceSpec | undefined {
  return SOURCES.find((s) => s.id === id);
}

/** §4.2.5: the `~/…` display form of any path. */
export function displayFor(path: string, home: string): string {
  return displayRoot(path, home);
}

/** §3: the atlas rows one tool contributes. */
export function specsForTool(tool: SourceTool): readonly SourceSpec[] {
  return SOURCES.filter((s) => s.tool === tool);
}
