/**
 * `grep` and `glob` (docs/AGENT-LOOP-DESIGN.md §4.6). Both answer from the files `Workspace.listCandidates()` lists, so
 * secret and ignored files never appear (src/workspace/candidates.ts). What the listing found but does not offer as a
 * candidate — binaries and files over 1 MiB (`listSkipped`, src/workspace/files.ts) — is not silently absent: `glob`
 * lists it with a tag, `grep` names the large text files it did not search, and both say when the listing itself
 * stopped at its cap.
 *
 * `grep` runs ripgrep through the sandbox when `rg --version` answers (probed once per run), and otherwise scans every
 * candidate with a JS `RegExp`, 16 files at a time, until its 20 s budget runs out — and says so when it stopped early.
 * `glob` converts the pattern to a RegExp over the listed paths; a pattern without a slash matches file names at any
 * depth, as `--glob` does in ripgrep, and a bare directory name lists the files under it.
 */
import { basename } from 'node:path';
import type { AgentContext, Candidate } from '../../core/types.js';
import { cleanCommandOutput, stripTerminalControls } from '../../core/ansi.js';
import { MAX_LIST_ENTRIES } from '../../workspace/candidates.js';
import { listSkipped, type SkippedFile, type SkippedListing } from '../../workspace/files.js';
import { WALK_SKIP_DIRS, isSkippedDirName } from '../../workspace/skip-dirs.js';
import { shellQuote } from '../../workspace/tests.js';
import {
  AGENT_FILE_MAX_BYTES,
  AGENT_GLOB_MAX_PATHS,
  AGENT_GREP_DEFAULT_RESULTS,
  AGENT_GREP_MAX_CHARS,
  AGENT_GREP_PARALLEL_READS,
  AGENT_GREP_TIMEOUT_MS,
  AGENT_RG_PROBE_TIMEOUT_MS,
} from '../limits.js';
import { normaliseWorkdir } from '../repair.js';
import { oneLine } from './format.js';
import { errorResult, isBinary, isVariablePath, type ToolResult } from './result.js';

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

/** The listed files under a workspace-relative directory (or equal to a file path), with paths relative to it. */
function under<T extends { path: string }>(items: readonly T[], dir: string | null): (T & { rel: string })[] {
  if (dir === null) return items.map((c) => ({ ...c, rel: c.path }));
  return items.flatMap((c) => (c.path === dir ? [{ ...c, rel: c.path.slice(c.path.lastIndexOf('/') + 1) }] : c.path.startsWith(`${dir}/`) ? [{ ...c, rel: c.path.slice(dir.length + 1) }] : []));
}

/** `path: "$TMPDIR"` named no workspace directory and answered a silent `0 matches`: only bash expands variables. */
export const SEARCH_VARIABLE_PATH_ERROR = `ERROR: grep and glob search workspace paths and do not expand variables such as $TMPDIR; search outside the workspace with bash (e.g. grep -rn 'pattern' "$TMPDIR")`;

/**
 * The workspace-relative directory a `path` argument names. glm-5.3-flash passes the root's own name (`path: "js-fix"` in
 * `…/js-fix`), which matched nothing and answered `0 files` (the S6 review): when no such directory exists, the root's name
 * means the root and `<root>/sub` means `sub` — the rule bash's workdir and read_file already follow. A path a shell would
 * expand (`$TMPDIR`, `${HOME}/x`) is refused, as the file tools refuse it.
 */
function searchDir(ctx: AgentContext, path: string | undefined, listed: readonly { path: string }[]): { ok: true; dir: string | null } | { ok: false; error: string } {
  if (path === undefined) return { ok: true, dir: null };
  if (isVariablePath(path)) return { ok: false, error: SEARCH_VARIABLE_PATH_ERROR };
  const wd = normaliseWorkdir(ctx.workspace.root, path);
  if (!wd.ok) return { ok: false, error: `ERROR: ${path} is outside the workspace` };
  const dir = wd.value;
  if (dir === null) return { ok: true, dir };
  const exists = (d: string): boolean => listed.some((c) => c.path === d || c.path.startsWith(`${d}/`));
  const name = basename(ctx.workspace.root);
  if (dir === name && !exists(dir)) return { ok: true, dir: null };
  if (dir.startsWith(`${name}/`) && !exists(dir)) return { ok: true, dir: dir.slice(name.length + 1) };
  return { ok: true, dir };
}

/** `2.7 MB` (MiB arithmetic, the unit of the 1 MiB cap) */
function sizeLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The tag `glob` puts after a listed file that is not a candidate: ` (binary)` or ` (2.7 MB)`. */
function skipTag(f: SkippedFile): string {
  return f.reason === 'binary' ? ' (binary)' : ` (${sizeLabel(f.bytes)})`;
}

/** Said by glob and grep when the workspace listing stopped at its cap: files beyond it are neither listed nor searched. */
export const WALK_CAP_LINE = `[the workspace listing stopped at its cap (${MAX_LIST_ENTRIES} entries), so files beyond it are neither listed nor searched; use bash (find, grep -r) for those]`;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * A pattern with no glob characters that names a directory (`assets`, `src/lib/`) matched nothing as a file: it lists the
 * directory's files instead, and the first line of the result says so. A slash-less name that is no directory at the top
 * lists every directory of that name (`**\/<name>/**`).
 */
function directoryPattern(pattern: string, listed: readonly { rel: string }[]): { pattern: string; line: string } | null {
  if (GLOB_CHARS.test(pattern)) return null;
  const d = pattern.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (d === '' || d === '.') return null;
  if (listed.some((c) => c.rel.startsWith(`${d}/`))) return { pattern: `${d}/**`, line: `${d} is a directory; listing ${d}/**` };
  if (!d.includes('/') && listed.some((c) => c.rel.includes(`/${d}/`))) return { pattern: `**/${d}/**`, line: `${d} names directories below the top; listing **/${d}/**` };
  return null;
}

export interface GlobArgs {
  pattern: string;
  path?: string;
}

interface Listed {
  path: string;
  /** '' for a candidate; ` (binary)` or ` (2.7 MB)` for a file the candidate rules skip */
  tag: string;
}

export async function runGlob(ctx: AgentContext, a: GlobArgs): Promise<ToolResult> {
  const candidates = await ctx.workspace.listCandidates();
  const skipped = await listSkipped(ctx.workspace);
  const listed: Listed[] = [...candidates.map((c) => ({ path: c.path, tag: '' })), ...skipped.files.map((f) => ({ path: f.path, tag: skipTag(f) }))];
  const where = searchDir(ctx, a.path, listed);
  if (!where.ok) return errorResult(where.error, `glob ${a.pattern} (error)`);
  const pool = under(listed, where.dir);
  const matching = (pattern: string): (Listed & { rel: string })[] => {
    const re = globToRegExp(pattern);
    return pool.filter((c) => globMatches(re, pattern, c.rel));
  };
  let matched = matching(a.pattern);
  let head: string | null = null;
  if (matched.length === 0) {
    const asDir = directoryPattern(a.pattern, pool);
    if (asDir !== null) {
      head = asDir.line;
      matched = matching(asDir.pattern);
    }
  }
  matched.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const shown = matched.slice(0, AGENT_GLOB_MAX_PATHS);
  const lines = [...(head !== null ? [head] : []), `${matched.length} files`, ...shown.map((c) => `${c.path}${c.tag}`)];
  if (matched.length > shown.length) lines.push(`[capped at ${AGENT_GLOB_MAX_PATHS} of ${matched.length} files; narrow the pattern]`);
  if (skipped.walkCapped) lines.push(WALK_CAP_LINE);
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
const GREP_SECONDS = Math.round(AGENT_GREP_TIMEOUT_MS / 1000);
/** skipped large files a grep names before `…` */
const LARGE_NAMED = 5;

/**
 * A matched or context line as the model reads it, from either executor: escape sequences removed whole and every other
 * control byte dropped (core/ansi.ts), a CRLF file's CR gone and a stray CR shown as a space, so one match stays one
 * row. read_file still shows the file's exact bytes.
 */
function lineText(text: string): string {
  return stripTerminalControls(text).replace(/\r$/, '').replace(/\r/g, ' ');
}

/** `notes` follow the results: the early stop, the large files not searched, the listing cap. */
function render(a: GrepArgs, lines: readonly GrepLine[], capped: boolean, notes: readonly string[]): ToolResult {
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
    const clean = lineText(l.text);
    const text = clean.length > LINE_TEXT_MAX ? `${clean.slice(0, LINE_TEXT_MAX)}…` : clean;
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
  parts.push(...notes);
  const text = parts.join('\n');
  return { text, ok: true, summary: `grep ${JSON.stringify(oneLine(a.pattern, 50))}${a.path !== undefined ? ` in ${a.path}` : ''} (${matches.length} matches)`, hashBasis: text };
}

/** Said when rg's output filled the cap before a listed file matched: the files it had not reached may hold matches. */
export const RG_OUTPUT_CAP_LINE = '[rg output reached the output cap before any listed file matched; narrow with path or glob]';

/** Parse `rg --null --line-number` output: `path\0N:text` for a match, `path\0N-text` for context, `--` between groups. */
function parseRg(stdout: string, allowed: ReadonlySet<string>): GrepLine[] {
  const out: GrepLine[] = [];
  for (const raw of stdout.split('\n')) {
    const nul = raw.indexOf('\0');
    if (nul < 0) continue;
    const path = raw.slice(0, nul).replace(/^\.\//, '');
    // `s`: a CRLF file's line ends in `\r`, which `.` does not match — without it every match in such a file was dropped
    const m = /^(\d+)([:-])(.*)$/s.exec(raw.slice(nul + 1));
    if (m === null || !allowed.has(path)) continue;
    out.push({ path, line: Number(m[1]), text: m[3] ?? '', match: m[2] === ':' });
  }
  return out;
}

/**
 * `!<name>/` for every skipped directory (src/workspace/skip-dirs.ts) that no listed file passes through. `--hidden`
 * would otherwise walk `.venv`, `.tox`, `.next` or `.cache` wherever no .gitignore hides them (any tree outside git):
 * parseRg drops those lines, but they fill the output cap first — a 200-package `.venv` turned a complete 2-file answer
 * into a false "results capped" note, and an unlucky walk order into a bare `0 matches`. A skipped name that a tracked
 * file passes through (a committed `dist/`) stays searchable. The trailing slash limits each glob to directories, so a
 * script named `build` is still searched.
 */
function skippedDirGlobs(allowed: ReadonlySet<string>): string[] {
  const kept = new Set<string>();
  for (const p of allowed) {
    const segs = p.split('/');
    for (let i = 0; i < segs.length - 1; i += 1) if (isSkippedDirName(segs[i]!)) kept.add(segs[i]!);
  }
  const globs: string[] = [];
  for (const name of WALK_SKIP_DIRS) if (name !== '.git' && !kept.has(name)) globs.push(`!${name}/`);
  if (![...kept].some((n) => n.endsWith('.egg-info'))) globs.push('!*.egg-info/');
  return globs;
}

/** `rg: <path>: <reason> (os error N)`: a file rg could not open (a sandbox read-deny on `.env`, a permission error). */
const RG_IO_ERROR = /^rg: (.*): [^:]+ \(os error \d+\)\s*$/;

/**
 * ripgrep with the flags that make it answer the same question on every machine: `--no-config` (a user's
 * `RIPGREP_CONFIG_PATH` could add `--smart-case`, colours or a glob), `--hidden` with `.git` and the unlisted skipped
 * directories excluded (the listing offers `.github/workflows/ci.yml` and `.eslintrc.js`, which rg skips by default) and
 * a 500-column preview of a long line (a minified bundle's one line must not fill the output cap before the real
 * matches arrive).
 */
async function grepWithRg(ctx: AgentContext, a: GrepArgs, dir: string | null, allowed: ReadonlySet<string>, notes: readonly string[]): Promise<ToolResult | null> {
  const argv = ['rg', '--no-config', '--null', '--line-number', '--no-heading', '--color', 'never', '--hidden', '--max-columns', String(LINE_TEXT_MAX), '--max-columns-preview'];
  if (a.case_insensitive === true) argv.push('-i');
  if (a.context !== undefined && a.context > 0) argv.push('-C', String(a.context));
  if (a.glob !== undefined) argv.push('--glob', shellQuote(a.glob));
  // last, so a broad user glob (`**`) cannot re-include them: in rg the later glob wins
  for (const g of ['!.git', ...skippedDirGlobs(allowed)]) argv.push('--glob', shellQuote(g));
  argv.push('-e', shellQuote(a.pattern));
  if (dir !== null) argv.push('--', shellQuote(dir));
  const r = await ctx.sandbox.run(argv.join(' '), { timeoutMs: AGENT_GREP_TIMEOUT_MS, maxOutputBytes: ctx.limits.maxOutputBytes, signal: ctx.signal });
  // core/ansi.ts, clean THEN redact (as every command path): stderr whole; stdout per line after the NUL-separated parse
  const stderr = cleanCommandOutput(r.stderr);
  if (r.exitCode === 2 && /regex parse error|error parsing regex|unclosed|repetition/i.test(stderr)) {
    const reason = stderr.split('\n').filter((l) => /error/i.test(l)).pop() ?? 'the pattern does not compile';
    return errorResult(`ERROR: invalid regular expression: ${oneLine(ctx.redact(reason), 300)}`, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (invalid regex)`);
  }
  // Exit 2 with nothing found is no answer — an older rg that does not know a flag, a sandbox refusal — and the caller
  // scans with JavaScript instead of reporting `0 matches`. Unless every stderr line is a file rg could not open: the
  // macOS profile read-denies `<cwd>/.env`, so with --hidden every zero-match search in a project with a .env exits 2,
  // and re-scanning the whole tree in JS for an answer rg already gave cost up to 20 s per "is this used anywhere?".
  const errLines = stderr.split('\n').filter((l) => l.trim() !== '');
  const ioOnly = errLines.length > 0 && errLines.every((l) => RG_IO_ERROR.test(l));
  if (r.exitCode === 2 && r.stdout.trim() === '' && !ioOnly) return null;
  const lines = parseRg(r.stdout, allowed).map((l) => ({ ...l, text: ctx.redact(lineText(l.text)) }));
  // a LISTED file rg could not open is named: its matches would otherwise be silently absent (unlisted ones, such as a
  // denied .env, are not candidates and stay unmentioned)
  const unreadable = errLines.flatMap((l) => {
    const m = RG_IO_ERROR.exec(l);
    const path = m?.[1]?.replace(/^\.\//, '');
    return path !== undefined && allowed.has(path) ? [path] : [];
  });
  const unread = unreadable.length > 0 ? [`[rg could not read ${unreadable.length === 1 ? '1 listed file' : `${unreadable.length} listed files`}: ${unreadable.slice(0, LARGE_NAMED).join(', ')}${unreadable.length > LARGE_NAMED ? '…' : ''}]`] : [];
  const stopped = r.killedBy === 'timeout' ? [`[rg stopped after ${GREP_SECONDS} s, so the results are partial; narrow with path or glob]`] : [];
  // a capped output with no listed match must not read as "absent": the files rg had not reached may hold matches
  const overflow = r.truncated && r.killedBy !== 'timeout' && !lines.some((l) => l.match) ? [RG_OUTPUT_CAP_LINE] : [];
  return render(a, lines, r.truncated || r.killedBy === 'timeout', [...stopped, ...overflow, ...unread, ...notes]);
}

/**
 * The pattern as a JS RegExp. A leading inline-flag group (`(?i)`, also `(?s)` / `(?m)` and combinations), which ripgrep
 * accepts and JS does not, becomes the flag; a pattern the `u` flag rejects (`return \"x\"`: an identity escape) is tried
 * again without it. The error text of the last attempt otherwise.
 */
export function compileGrepPattern(pattern: string, caseInsensitive: boolean): RegExp | { error: string } {
  let source = pattern;
  let flags = caseInsensitive ? 'i' : '';
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline !== null) {
    source = source.slice(inline[0].length);
    for (const f of inline[1]!) if (!flags.includes(f)) flags += f;
  }
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}

async function scanFile(ctx: AgentContext, path: string, re: RegExp, ctxLines: number): Promise<GrepLine[]> {
  let content: string;
  try {
    content = (await ctx.workspace.read(path, AGENT_FILE_MAX_BYTES)).content;
  } catch {
    return [];
  }
  if (isBinary(content)) return [];
  const lines = content.split(/\r?\n/);
  const keep = new Map<number, boolean>();
  lines.forEach((l, i) => {
    if (!re.test(l)) return;
    keep.set(i, true);
    for (let k = Math.max(0, i - ctxLines); k <= Math.min(lines.length - 1, i + ctxLines); k += 1) if (!keep.has(k)) keep.set(k, false);
  });
  return [...keep.keys()].sort((x, y) => x - y).map((i) => ({ path, line: i + 1, text: lines[i]!, match: keep.get(i) === true }));
}

/**
 * The fallback without ripgrep: every listed file, `AGENT_GREP_PARALLEL_READS` at a time, until the matches pass
 * `max_results`, the 20 s budget (`ctx.now()`) runs out, or the run stops. Files are taken in path order and every file
 * taken is finished, so the searched set is always a prefix of the list and the answer does not depend on which read
 * finished first. A scan that stopped early says how far it got — also at 0 matches, which must never read as "absent".
 */
async function grepWithJs(ctx: AgentContext, a: GrepArgs, files: readonly { path: string }[], notes: readonly string[]): Promise<ToolResult> {
  const re = compileGrepPattern(a.pattern, a.case_insensitive === true);
  if (!(re instanceof RegExp)) return errorResult(`ERROR: invalid regular expression: ${re.error}`, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (invalid regex)`);
  const max = a.max_results ?? AGENT_GREP_DEFAULT_RESULTS;
  const ctxLines = a.context ?? 0;
  const deadline = ctx.now() + AGENT_GREP_TIMEOUT_MS;
  const results: (GrepLine[] | undefined)[] = new Array<GrepLine[] | undefined>(files.length);
  let next = 0;
  let found = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (found > max) return;
      if (ctx.signal.aborted || ctx.now() >= deadline) {
        stopped = true;
        return;
      }
      const i = next;
      if (i >= files.length) return;
      next += 1;
      const lines = await scanFile(ctx, files[i]!.path, re, ctxLines);
      results[i] = lines;
      for (const l of lines) if (l.match) found += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GREP_PARALLEL_READS, files.length) }, worker));
  const out: GrepLine[] = [];
  let matches = 0;
  let capped = false;
  let searched = 0;
  for (const lines of results) {
    if (lines === undefined) break;
    searched += 1;
    out.push(...lines);
    for (const l of lines) if (l.match) matches += 1;
    if (matches > max) {
      capped = true;
      break;
    }
  }
  const early = stopped && !capped && searched < files.length ? [`[searched ${searched} of ${files.length} files in ${GREP_SECONDS} s; narrow with path or glob]`] : [];
  return render(a, out, capped, [...early, ...notes]);
}

/** `[3 files over 1 MiB were not searched: a, b, c]`, naming at most five. */
function largeLine(large: readonly { path: string }[]): string {
  const names = large.slice(0, LARGE_NAMED).map((f) => f.path).join(', ');
  const more = large.length > LARGE_NAMED ? '…' : '';
  const one = large.length === 1;
  const verb = one ? '1 file over 1 MiB was not searched' : `${large.length} files over 1 MiB were not searched`;
  return `[${verb}: ${names}${more}; search ${one ? 'it' : 'them'} with bash, e.g. grep -n]`;
}

function skippedNotes(skipped: SkippedListing, inScope: (items: readonly SkippedFile[]) => readonly SkippedFile[]): string[] {
  const notes: string[] = [];
  const large = inScope(skipped.files.filter((f) => f.reason === 'large'));
  if (large.length > 0) notes.push(largeLine(large));
  if (skipped.walkCapped) notes.push(WALK_CAP_LINE);
  return notes;
}

export async function runGrep(ctx: AgentContext, a: GrepArgs, rgAvailable: (ctx: AgentContext) => Promise<boolean>): Promise<ToolResult> {
  const candidates: Candidate[] = await ctx.workspace.listCandidates();
  const skipped = await listSkipped(ctx.workspace);
  const where = searchDir(ctx, a.path, [...candidates, ...skipped.files]);
  if (!where.ok) return errorResult(where.error, `grep ${JSON.stringify(oneLine(a.pattern, 50))} (error)`);
  const glob = a.glob;
  const re = glob !== undefined ? globToRegExp(glob) : null;
  const inScope = <T extends { path: string }>(items: readonly T[]): T[] => under(items, where.dir).filter((c) => re === null || glob === undefined || globMatches(re, glob, c.rel));
  const notes = skippedNotes(skipped, inScope);
  if (await rgAvailable(ctx)) {
    const viaRg = await grepWithRg(ctx, a, where.dir, new Set(candidates.map((c) => c.path)), notes);
    if (viaRg !== null) return viaRg;
  }
  return grepWithJs(ctx, a, inScope(candidates), notes);
}
