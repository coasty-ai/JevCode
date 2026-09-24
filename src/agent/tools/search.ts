/**
 * `grep` and `glob` (docs/AGENT-LOOP-DESIGN.md §4.6). Both answer only with files `Workspace.listCandidates()` lists, so
 * secret, ignored and binary files never appear (src/workspace/candidates.ts).
 *
 * `grep` runs ripgrep through the sandbox when `rg --version` answers (probed once per run), and otherwise scans the
 * candidates with a JS `RegExp`. `glob` converts the pattern to a RegExp over the candidate paths; a pattern without a
 * slash matches file names at any depth, as `--glob` does in ripgrep.
 */
import { basename } from 'node:path';
import type { AgentContext, Candidate } from '../../core/types.js';
import { shellQuote } from '../../workspace/tests.js';
import {
  AGENT_FILE_MAX_BYTES,
  AGENT_GLOB_MAX_PATHS,
  AGENT_GREP_DEFAULT_RESULTS,
  AGENT_GREP_MAX_CHARS,
  AGENT_GREP_MAX_FILES,
  AGENT_GREP_TIMEOUT_MS,
  AGENT_RG_PROBE_TIMEOUT_MS,
} from '../limits.js';
import { normaliseWorkdir } from '../repair.js';
import { oneLine } from './format.js';
import { errorResult, isBinary, type ToolResult } from './result.js';

// ---------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------

function globSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < glob.length && depth > 0; j += 1) {
        if (glob[j] === '{') depth += 1;
        else if (glob[j] === '}') depth -= 1;
      }
      const body = glob.slice(i + 1, j - 1);
      const alts: string[] = [];
      let level = 0;
      let start = 0;
      for (let k = 0; k < body.length; k += 1) {
        if (body[k] === '{') level += 1;
        else if (body[k] === '}') level -= 1;
        else if (body[k] === ',' && level === 0) {
          alts.push(body.slice(start, k));
          start = k + 1;
        }
      }
      alts.push(body.slice(start));
      re += `(?:${alts.map(globSource).join('|')})`;
      i = j - 1;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        const cls = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        re += `[${cls}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return re;
}

/** A glob (`**`, `*`, `?`, `{a,b}`, `[…]`) as an anchored RegExp over a posix path. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob.replace(/^\.\//, '').replace(/^\//, ''))}$`);
}

/** Does `path` (relative to the search directory) match? A slash-less pattern matches the file name at any depth. */
export function globMatches(re: RegExp, glob: string, path: string): boolean {
  if (glob.includes('/')) return re.test(path);
  return re.test(path.slice(path.lastIndexOf('/') + 1));
}

/** The candidates under a workspace-relative directory (or equal to a file path), with paths relative to it. */
function under(candidates: readonly Candidate[], dir: string | null): { path: string; rel: string }[] {
  if (dir === null) return candidates.map((c) => ({ path: c.path, rel: c.path }));
  return candidates.flatMap((c) => (c.path === dir ? [{ path: c.path, rel: c.path.slice(c.path.lastIndexOf('/') + 1) }] : c.path.startsWith(`${dir}/`) ? [{ path: c.path, rel: c.path.slice(dir.length + 1) }] : []));
}

/**
 * The workspace-relative directory a `path` argument names. glm-5.3-flash passes the root's own name (`path: "js-fix"` in
 * `…/js-fix`), which matched nothing and answered `0 files` (the S6 review): when no such directory exists, the root's name
 * means the root and `<root>/sub` means `sub` — the rule bash's workdir and read_file already follow.
 */
function searchDir(ctx: AgentContext, path: string | undefined, candidates: readonly Candidate[]): { ok: true; dir: string | null } | { ok: false; error: string } {
  if (path === undefined) return { ok: true, dir: null };
  const wd = normaliseWorkdir(ctx.workspace.root, path);
  if (!wd.ok) return { ok: false, error: `ERROR: ${path} is outside the workspace` };
  const dir = wd.value;
  if (dir === null) return { ok: true, dir };
  const exists = (d: string): boolean => candidates.some((c) => c.path === d || c.path.startsWith(`${d}/`));
  const name = basename(ctx.workspace.root);
  if (dir === name && !exists(dir)) return { ok: true, dir: null };
  if (dir.startsWith(`${name}/`) && !exists(dir)) return { ok: true, dir: dir.slice(name.length + 1) };
  return { ok: true, dir };
}

export interface GlobArgs {
  pattern: string;
  path?: string;
}

export async function runGlob(ctx: AgentContext, a: GlobArgs): Promise<ToolResult> {
  const candidates = await ctx.workspace.listCandidates();
  const where = searchDir(ctx, a.path, candidates);
  if (!where.ok) return errorResult(where.error, `glob ${a.pattern} (error)`);
  const re = globToRegExp(a.pattern);
  const matched = under(candidates, where.dir)
    .filter((c) => globMatches(re, a.pattern, c.rel))
    .map((c) => c.path)
    .sort();
  const shown = matched.slice(0, AGENT_GLOB_MAX_PATHS);
  const lines = [`${matched.length} files`, ...shown];
  if (matched.length > shown.length) lines.push(`[capped at ${AGENT_GLOB_MAX_PATHS} of ${matched.length} files; narrow the pattern]`);
  const text = lines.join('\n');
  return { text, ok: true, summary: `glob ${oneLine(a.pattern, 60)} (${matched.length} files)`, hashBasis: text };
}

// ---------------------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------------------

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  context?: number;
  max_results?: number;
}

/** `rg --version`, once per run: the executor is chosen by what the sandbox's PATH holds. */
export function createRgProbe(): (ctx: AgentContext) => Promise<boolean> {
  let probe: Promise<boolean> | null = null;
  return (ctx) => {
    // a probe cut short by the run's own pause is no answer: the next grep after the resume asks again
    const settle = (ok: boolean): boolean => {
      if (ctx.signal.aborted) probe = null;
      return ok;
    };
    probe ??= ctx.sandbox.run('rg --version', { timeoutMs: AGENT_RG_PROBE_TIMEOUT_MS, maxOutputBytes: 4096, signal: ctx.signal }).then(
      (r) => settle(r.exitCode === 0 && r.killedBy === null),
      () => settle(false),
    );
    return probe;
  };
}

interface GrepLine {
  path: string;
  line: number;
  text: string;
  match: boolean;
}

const LINE_TEXT_MAX = 500;

function render(a: GrepArgs, lines: readonly GrepLine[], capped: boolean): ToolResult {
  const max = a.max_results ?? AGENT_GREP_DEFAULT_RESULTS;
  const matches = lines.filter((l) => l.match);
  const files = new Set(matches.map((l) => l.path));
  const out: string[] = [];
  let shownMatches = 0;
  let chars = 0;
  let clipped = capped;
  for (const l of lines) {
    if (l.match && shownMatches >= max) {
      clipped = true;
      break;
    }
    const text = l.text.length > LINE_TEXT_MAX ? `${l.text.slice(0, LINE_TEXT_MAX)}…` : l.text;
    const row = l.match ? `${l.path}:${l.line}: ${text}` : `${l.path}-${l.line}- ${text}`;
    if (chars + row.length + 1 > AGENT_GREP_MAX_CHARS) {
      clipped = true;
      break;
    }
    out.push(row);
    chars += row.length + 1;
    if (l.match) shownMatches += 1;
  }
  const head = matches.length === 0 ? '0 matches' : `${matches.length} matches in ${files.size} files (showing ${shownMatches})`;
  const parts = [head, ...out];
  if (clipped && matches.length > 0) parts.push(`[results capped at ${shownMatches}; narrow with path or glob]`);
  const text = parts.join('\n');
  return { text, ok: true, summary: `grep ${JSON.stringify(oneLine(a.pattern, 50))}${a.path !== undefined ? ` in ${a.path}` : ''} (${matches.length} matches)`, hashBasis: text };
}

/** Parse `rg --null --line-number` output: `path\0N:text` for a match, `path\0N-text` for context, `--` between groups. */
function parseRg(stdout: string, allowed: ReadonlySet<string>): GrepLine[] {
  const out: GrepLine[] = [];
  for (const raw of stdout.split('\n')) {
    const nul = raw.indexOf('\0');
    if (nul < 0) continue;
    const path = raw.slice(0, nul).replace(/^\.\//, '');
    const m = /^(\d+)([:-])(.*)$/.exec(raw.slice(nul + 1));
    if (m === null || !allowed.has(path)) continue;
    out.push({ path, line: Number(m[1]), text: m[3] ?? '', match: m[2] === ':' });
  }
  return out;
}

async function grepWithRg(ctx: AgentContext, a: GrepArgs, dir: string | null, allowed: ReadonlySet<string>): Promise<ToolResult> {
  const argv = ['rg', '--null', '--line-number', '--no-heading', '--color', 'never'];
  if (a.case_insensitive === true) argv.push('-i');
  if (a.context !== undefined && a.context > 0) argv.push('-C', String(a.context));
  if (a.glob !== undefined) argv.push('--glob', shellQuote(a.glob));
  argv.push('-e', shellQuote(a.pattern));
  if (dir !== null) argv.push('--', shellQuote(dir));
  const r = await ctx.sandbox.run(argv.join(' '), { timeoutMs: AGENT_GREP_TIMEOUT_MS, maxOutputBytes: ctx.limits.maxOutputBytes, signal: ctx.signal });
  if (r.exitCode === 2 && /regex parse error|error parsing regex|unclosed|repetition/i.test(r.stderr)) {
    const reason = r.stderr.split('\n').filter((l) => /error/i.test(l)).pop() ?? 'the pattern does not compile';
    return errorResult(`ERROR: invalid regular expression: ${oneLine(ctx.redact(reason), 300)}`, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (invalid regex)`);
  }
  const lines = parseRg(ctx.redact(r.stdout), allowed);
  return render(a, lines, r.truncated || r.killedBy === 'timeout');
}

async function grepWithJs(ctx: AgentContext, a: GrepArgs, files: readonly { path: string; rel: string }[]): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(a.pattern, a.case_insensitive === true ? 'iu' : 'u');
  } catch (e) {
    return errorResult(`ERROR: invalid regular expression: ${e instanceof Error ? e.message : String(e)}`, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (invalid regex)`);
  }
  const max = a.max_results ?? AGENT_GREP_DEFAULT_RESULTS;
  const ctxLines = a.context ?? 0;
  const out: GrepLine[] = [];
  let matches = 0;
  let capped = false;
  for (const f of files.slice(0, AGENT_GREP_MAX_FILES)) {
    let content: string;
    try {
      content = (await ctx.workspace.read(f.path, AGENT_FILE_MAX_BYTES)).content;
    } catch {
      continue;
    }
    if (isBinary(content)) continue;
    const lines = content.split('\n');
    const keep = new Map<number, boolean>();
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      keep.set(i, true);
      for (let k = Math.max(0, i - ctxLines); k <= Math.min(lines.length - 1, i + ctxLines); k += 1) if (!keep.has(k)) keep.set(k, false);
    });
    for (const i of [...keep.keys()].sort((x, y) => x - y)) out.push({ path: f.path, line: i + 1, text: lines[i]!, match: keep.get(i) === true });
    matches += [...keep.values()].filter(Boolean).length;
    if (matches > max) {
      capped = true;
      break;
    }
  }
  if (files.length > AGENT_GREP_MAX_FILES) capped = true;
  return render(a, out, capped);
}

export async function runGrep(ctx: AgentContext, a: GrepArgs, rgAvailable: (ctx: AgentContext) => Promise<boolean>): Promise<ToolResult> {
  const candidates = await ctx.workspace.listCandidates();
  const where = searchDir(ctx, a.path, candidates);
  if (!where.ok) return errorResult(where.error, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (error)`);
  const allowed = new Set(candidates.map((c) => c.path));
  if (await rgAvailable(ctx)) return grepWithRg(ctx, a, where.dir, allowed);
  const glob = a.glob;
  const re = glob !== undefined ? globToRegExp(glob) : null;
  const files = under(candidates, where.dir).filter((c) => re === null || glob === undefined || globMatches(re, glob, c.rel));
  return grepWithJs(ctx, a, files);
}
