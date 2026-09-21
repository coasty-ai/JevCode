/**
 * The only module that spawns git through the sandbox (DESIGN.md §8, defence 2).
 *
 * A `run` action may plant `core.fsmonitor`, hooks, `diff.external` or a pager in the
 * workspace's `.git/config`; ordinary harness commands (`status`, `ls-files`, `diff`) would
 * execute them with the harness's environment. So every sandboxed harness git call goes through
 * `runGit` with the scrubbed env plus GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL=/dev/null and
 * `-c` overrides that neutralise the executable knobs. One exception, by design: the two
 * read-only run-start probes of `workspace/gitstate.ts` (`rev-parse`, `--no-optional-locks
 * status`) run UNSANDBOXED — they precede the sandbox, whose profile needs their answer — with
 * exactly the same `GIT_BASE_FLAGS` + `GIT_ENV` (TUI-DESIGN §12.1); defence 1 (the seatbelt)
 * does not cover them, defence 2 does. Output is untrusted text: bounded and parsed defensively.
 */
import { dirname } from 'node:path';

import type { ExecResult, GitHead, GitState, Sandbox, StatusEntryV2 } from '../core/types.js';

export interface GitRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** extra child env merged over GIT_ENV (never process.env) */
  env?: Record<string, string>;
}

export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export const GIT_BASE_FLAGS: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=',
  '-c', 'credential.helper=',
  '-c', 'diff.external=',
  '-c', 'color.ui=false',
];

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const NEVER = new AbortController().signal;

/** POSIX single-quote quoting: the only safe way to hand arbitrary args to `sh -c`. */
export function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+@%,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

function extraFlags(sub: string | undefined): string[] {
  if (sub === 'status') return ['--no-optional-locks'];
  return [];
}

function subcommandFlags(sub: string | undefined): string[] {
  if (sub === 'diff') return ['--no-ext-diff', '--no-textconv'];
  return [];
}

export async function runGit(sandbox: Sandbox, ws: string, args: readonly string[], opts: GitRunOptions = {}): Promise<ExecResult> {
  for (const a of args) if (typeof a !== 'string' || a.includes('\0')) throw new TypeError('git argument must be a string without NUL');
  const sub = args.find((a) => !a.startsWith('-'));
  const subIndex = sub === undefined ? args.length : args.indexOf(sub);
  const before = args.slice(0, subIndex);
  const after = args.slice(subIndex + 1);
  const full = ['git', ...GIT_BASE_FLAGS, ...extraFlags(sub), ...before, ...(sub === undefined ? [] : [sub]), ...subcommandFlags(sub), ...after];
  const runOpts = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    signal: opts.signal ?? NEVER,
    env: { ...GIT_ENV, ...(opts.env ?? {}) },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : { cwd: ws }),
  };
  return sandbox.run(shellJoin(full), runOpts);
}

/** True when `ws` is inside a git work tree (and git itself is available). */
export async function isRepo(sandbox: Sandbox, ws: string): Promise<boolean> {
  const r = await runGit(sandbox, ws, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

/**
 * The repository directory as git resolves it (follows a `gitdir:` pointer file), relative
 * to `ws` when inside it, else absolute; null outside a repo.
 */
export async function gitDir(sandbox: Sandbox, ws: string): Promise<string | null> {
  const r = await runGit(sandbox, ws, ['rev-parse', '--git-dir']);
  const t = r.stdout.trim();
  return r.ok && t.length > 0 ? t : null;
}

/**
 * `ws` relative to the work-tree top level (`sub/dir/`, trailing slash), '' when `ws` is the
 * top level itself or not a repo. `git status --porcelain` paths are always top-level
 * relative, so a non-empty prefix must be stripped before they are compared with workspace
 * paths.
 */
export async function showPrefix(sandbox: Sandbox, ws: string): Promise<string> {
  const r = await runGit(sandbox, ws, ['rev-parse', '--show-prefix']);
  const t = r.stdout.trim();
  return r.ok && t.length > 0 && !t.startsWith('/') && !t.includes('..') ? (t.endsWith('/') ? t : `${t}/`) : '';
}

/** Absolute path of the work-tree top level, or null. */
export async function topLevel(sandbox: Sandbox, ws: string): Promise<string | null> {
  const r = await runGit(sandbox, ws, ['rev-parse', '--show-toplevel']);
  const t = r.stdout.trim();
  return r.ok && t.length > 0 ? t : null;
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((s) => s.length > 0);
}

/**
 * Tracked plus untracked-not-ignored paths (so files the generator created remain
 * candidates); entries with mode 120000 (symlinks) are dropped here because git reports
 * them as regular listing entries.
 */
export async function lsFiles(sandbox: Sandbox, ws: string, opts: GitRunOptions = {}): Promise<{ paths: string[]; truncated: boolean }> {
  const r = await runGit(sandbox, ws, ['ls-files', '-s', '-co', '--exclude-standard', '-z'], opts);
  if (!r.ok) return { paths: [], truncated: r.truncated };
  // Tracked files removed from the working tree are still index entries; drop them.
  const deleted = await runGit(sandbox, ws, ['ls-files', '-d', '-z'], opts);
  const gone = new Set(deleted.ok ? splitNul(deleted.stdout) : []);
  const paths: string[] = [];
  for (const entry of splitNul(r.stdout)) {
    const tab = entry.indexOf('\t');
    if (tab === -1) {
      // untracked: bare path
      paths.push(entry);
      continue;
    }
    const meta = entry.slice(0, tab);
    const mode = meta.split(' ')[0];
    if (mode === '120000' || mode === '160000') continue;
    const path = entry.slice(tab + 1);
    if (!gone.has(path)) paths.push(path);
  }
  return { paths, truncated: r.truncated || deleted.truncated };
}

export interface StatusEntry {
  /** two-character porcelain code, e.g. ' M', '??', 'R ' */
  code: string;
  path: string;
  /** original path of a rename/copy */
  from?: string;
}

/** `git status --porcelain --untracked-files=all -z`, parsed (renames carry `from`). */
export async function statusPorcelain(sandbox: Sandbox, ws: string, opts: GitRunOptions = {}): Promise<{ entries: StatusEntry[]; ok: boolean; truncated: boolean }> {
  const r = await runGit(sandbox, ws, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], opts);
  if (!r.ok) return { entries: [], ok: false, truncated: r.truncated };
  const parts = r.stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    const path = p.slice(3);
    if ((code[0] === 'R' || code[0] === 'C') && i + 1 < parts.length) {
      entries.push({ code, path, from: parts[++i]! });
    } else {
      entries.push({ code, path });
    }
  }
  return { entries, ok: true, truncated: r.truncated };
}

/**
 * TUI-DESIGN §12.4 (C40): the top-level flag that makes every pathspec of ONE command a literal path — no glob
 * characters, no `:` magic. `restoreFromHead` and `lsFilesTracked` take recorded file names, where `pages/[slug].tsx`
 * must mean that file and never `pages/s.tsx`, and `:!keep.txt` must never mean "everything but". Never part of
 * `GIT_BASE_FLAGS`: `diffAgainst` relies on `:(exclude)` magic.
 */
export const LITERAL_PATHSPECS_FLAG = '--literal-pathspecs';

/**
 * `git --literal-pathspecs ls-files --error-unmatch -z -- <path>` succeeds only for tracked paths; the listing must
 * name exactly `relPath` (fix-pass finding 8: with glob pathspecs `pages/[slug].tsx` also matched a tracked `pages/s.tsx`
 * and an untracked bracket-named file read as tracked).
 */
export async function lsFilesTracked(sandbox: Sandbox, ws: string, relPath: string, opts: GitRunOptions = {}): Promise<boolean> {
  const r = await runGit(sandbox, ws, [LITERAL_PATHSPECS_FLAG, 'ls-files', '--error-unmatch', '-z', '--', relPath], opts);
  return r.ok && splitNul(r.stdout).includes(relPath);
}

/**
 * When `ws` is a strict subdirectory of its repository, `git apply` treats `diff --git`
 * headers as top-level relative and silently skips every path outside the subdirectory
 * (exit 0, nothing written; verified on git 2.50.1). Stopping repository discovery at the
 * workspace's parent makes git apply the patch as a plain patcher with paths relative to
 * `ws`, which is what resolveInside validated.
 */
function applyEnv(ws: string, plain: boolean): Record<string, string> {
  return plain ? { GIT_CEILING_DIRECTORIES: dirname(ws) } : {};
}

/** `git apply --check -p1 <file>`; never --unsafe-paths, --3way or --reject. */
export function applyCheck(sandbox: Sandbox, ws: string, patchFile: string, opts: GitRunOptions & { plain?: boolean } = {}): Promise<ExecResult> {
  const { plain, ...rest } = opts;
  return runGit(sandbox, ws, ['apply', '--check', '-p1', '--', patchFile], { ...rest, env: { ...applyEnv(ws, plain === true), ...(rest.env ?? {}) } });
}

export function apply(sandbox: Sandbox, ws: string, patchFile: string, opts: GitRunOptions & { plain?: boolean } = {}): Promise<ExecResult> {
  const { plain, ...rest } = opts;
  return runGit(sandbox, ws, ['apply', '-p1', '--', patchFile], { ...rest, env: { ...applyEnv(ws, plain === true), ...(rest.env ?? {}) } });
}

/** TUI-DESIGN §12.4 (C40, D8): the one restore verb — worktree only, never `checkout --`, `--staged`, `stash`, `reset` or `clean`. */
export const RESTORE_ARGS: readonly string[] = ['restore', '--source=HEAD', '--worktree'];

/**
 * TUI-DESIGN §12.4 (A146, C40): `git --literal-pathspecs restore --source=HEAD --worktree -- <paths>`
 * through `runGit` with the neutralising flags. Restores the working-tree copy of clean tracked files a
 * command changed; the index and refs are never touched. Paths are workspace-relative LITERAL file
 * names (cwd = `ws`): without `--literal-pathspecs` they would be glob pathspecs, and a recorded
 * `pages/[slug].tsx` restored a dirty `pages/s.tsx` while a `:!keep.txt` restored the whole tree
 * (fix-pass blocker 1, verified on git 2.50.1) — the promise that only the recorded paths are touched
 * would be broken with no pre-image to recover from. Absolute paths, `..` segments, empty strings and
 * NUL are refused before anything is spawned, and an empty list is a caller bug (`git restore` would
 * otherwise print usage and exit 128).
 */
export function restoreFromHead(sandbox: Sandbox, ws: string, paths: readonly string[], opts: GitRunOptions = {}): Promise<ExecResult> {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('restoreFromHead: at least one path is required');
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) throw new TypeError('restoreFromHead: paths must be non-empty strings without NUL');
    if (p.startsWith('/') || p.split('/').includes('..')) throw new TypeError(`restoreFromHead: path "${p}" must be workspace-relative`);
  }
  // `runGit` keeps a flag before the subcommand where git wants it: `git -c … --literal-pathspecs restore …`
  return runGit(sandbox, ws, [LITERAL_PATHSPECS_FLAG, ...RESTORE_ARGS, '--', ...paths], opts);
}

/**
 * Bench helper: the run's changes as a binary-safe unified diff against `base`, with
 * untracked files included through intent-to-add and `excludes` (test files) left out.
 */
export async function diffAgainst(sandbox: Sandbox, ws: string, base: string, excludes: readonly string[] = [], opts: GitRunOptions = {}): Promise<{ diff: string; ok: boolean; truncated: boolean; stderr: string }> {
  if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(base)) throw new TypeError(`unsafe git revision "${base}"`);
  const add = await runGit(sandbox, ws, ['add', '-A', '-N', '--', '.'], opts);
  if (!add.ok) return { diff: '', ok: false, truncated: add.truncated, stderr: add.stderr };
  const pathspec = ['--', '.', ...excludes.map((e) => `:(exclude)${e}`)];
  const r = await runGit(sandbox, ws, ['diff', '--binary', base, ...pathspec], { maxOutputBytes: 32 * 1024 * 1024, ...opts });
  return { diff: r.stdout, ok: r.ok, truncated: r.truncated, stderr: r.stderr };
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN §12.1: `git status --porcelain=v2 --branch --untracked-files=all -z`, parsed
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §12.1: the dirty-set counts and entries of a porcelain v2 listing (the shape of `GitState.dirty`). */
export type GitDirty = GitState['dirty'];

/** TUI-DESIGN §12.1: everything `statusPorcelainV2` reads from the probe's stdout. */
export interface PorcelainV2 {
  /** null when the output carried no `--branch` headers */
  head: GitHead | null;
  upstream: string | null;
  /** null without an upstream (`# branch.ab` absent) */
  ahead: number | null;
  behind: number | null;
  /** `# stash <n>` (only with `--show-stash`); null when absent */
  stash: number | null;
  dirty: GitDirty;
  /** the output ended without its NUL terminator or held a malformed entry: counts are lower bounds */
  torn: boolean;
}

/** `?` entries carry no XY field in v2; they are recorded with the v1 code so callers can treat both listings alike. */
export const UNTRACKED_XY = '??';
const NO_SUBMODULE = 'N...';
const OID_RE = /^[0-9a-f]{4,64}$/;

function emptyDirty(): GitDirty {
  return { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] };
}

const V1_UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * TUI-DESIGN §12.1 / §15 item 8: the per-command `git status --porcelain=v1` refresh re-expressed as
 * `GitState.dirty` so `workspace.gitState()` keeps current counts without a second listing. v1 has no
 * submodule column (`sub` is `N...`) and no hashes; `' '` becomes `'.'` so `xy` reads like v2.
 */
export function statusV1ToDirty(entries: readonly StatusEntry[]): GitDirty {
  const dirty = emptyDirty();
  for (const e of entries) {
    if (typeof e.code !== 'string' || e.code.length !== 2 || typeof e.path !== 'string' || e.path.length === 0) continue;
    const x = e.code[0] ?? ' ';
    const y = e.code[1] ?? ' ';
    if (x === '?' || y === '?') {
      dirty.untracked++;
      dirty.entries.push({ xy: UNTRACKED_XY, sub: NO_SUBMODULE, path: e.path });
      continue;
    }
    if (x === '!' || y === '!') continue;
    const xy = `${x === ' ' ? '.' : x}${y === ' ' ? '.' : y}`;
    const entry: StatusEntryV2 = { xy, sub: NO_SUBMODULE, path: e.path, ...(e.from !== undefined ? { from: e.from } : {}) };
    if (V1_UNMERGED.has(e.code)) {
      dirty.unmerged++;
      dirty.entries.push(entry);
      continue;
    }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') dirty.renamed++;
    if (x !== ' ') dirty.staged++;
    if (y !== ' ') dirty.modified++;
    dirty.entries.push(entry);
  }
  return dirty;
}

/** Split `line` into its first `n` space-separated tokens and the verbatim remainder (paths may contain spaces). */
function tokens(line: string, n: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = line.indexOf(' ', pos);
    if (sp === -1) return null;
    fields.push(line.slice(pos, sp));
    pos = sp + 1;
  }
  const rest = line.slice(pos);
  return rest.length === 0 ? null : { fields, rest };
}

const COUNT_RE = /^[+-]?\d{1,15}$/;

/** `+2` / `-0` / `3` → a non-negative integer; an empty, missing or non-numeric field → null (never 0). */
function parseCount(s: string | undefined): number | null {
  if (s === undefined || !COUNT_RE.test(s)) return null;
  return Number(s.replace(/^[+-]/, ''));
}

function headOf(oid: string | null, name: string | null): GitHead | null {
  if (oid === null && name === null) return null;
  if (oid === '(initial)') return { kind: 'unborn', name: name === null || name === '(detached)' ? 'HEAD' : name };
  if (name === '(detached)') return oid !== null && OID_RE.test(oid) ? { kind: 'detached', oid } : { kind: 'unborn', name: 'HEAD' };
  return { kind: 'branch', name: name ?? 'HEAD', oid: oid !== null && OID_RE.test(oid) ? oid : null };
}

/**
 * TUI-DESIGN §12.1: pure parser of `git status --porcelain=v2 --branch --untracked-files=all -z`
 * output (never spawns). Handles the ten line kinds — the four `# branch.*` headers, `# stash`,
 * ordinary (`1`), rename/copy (`2`, NUL-separated original path), unmerged (`u`), untracked (`?`)
 * and ignored (`!`) entries — plus `(initial)`, `(detached)`, `S<c><m><u>` submodule columns and
 * torn output. Paths are top-level relative exactly as git prints them (the caller strips
 * `prefix`). `modified` counts entries with a worktree change (Y ≠ '.'), `staged` those with an
 * index change (X ≠ '.'); a file that is both counts in both.
 */
export function statusPorcelainV2(stdout: string): PorcelainV2 {
  const dirty = emptyDirty();
  let oid: string | null = null;
  let headName: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let stash: number | null = null;
  let torn = false;
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return { head: null, upstream: null, ahead: null, behind: null, stash: null, dirty, torn: false };
  }
  const parts = stdout.split('\0');
  // A well-formed listing ends with NUL, so the final element is empty; anything else is a torn tail.
  const tail = parts.pop();
  if (tail !== undefined && tail.length > 0) torn = true;

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.length < 2) {
      if (line.length > 0) torn = true;
      continue;
    }
    const kind = line[0]!;
    if (kind === '#') {
      if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length);
      else if (line.startsWith('# branch.head ')) headName = line.slice('# branch.head '.length);
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length);
      else if (line.startsWith('# branch.ab ')) {
        const ab = line.slice('# branch.ab '.length).split(' ');
        ahead = parseCount(ab[0]);
        behind = parseCount(ab[1]);
      } else if (line.startsWith('# stash ')) stash = parseCount(line.slice('# stash '.length));
      // other headers are ignored (forward compatibility)
      continue;
    }
    if (kind === '?' || kind === '!') {
      if (line[1] !== ' ' || line.length < 3) {
        torn = true;
        continue;
      }
      if (kind === '?') {
        dirty.untracked++;
        dirty.entries.push({ xy: UNTRACKED_XY, sub: NO_SUBMODULE, path: line.slice(2) });
      }
      continue;
    }
    if (kind === '1' || kind === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const t = tokens(line, kind === '1' ? 8 : 9);
      if (t === null) {
        torn = true;
        continue;
      }
      const [, xy = '', sub = NO_SUBMODULE, , , mW = '', hH = '', hI = ''] = t.fields;
      if (xy.length !== 2) {
        torn = true;
        continue;
      }
      const entry: StatusEntryV2 = { xy, sub, path: t.rest, hH, hI, mode: mW };
      if (kind === '2') {
        const from = parts[i + 1];
        if (from === undefined || from.length === 0) {
          torn = true;
          continue;
        }
        i++;
        entry.from = from;
        dirty.renamed++;
      }
      if (xy[0] !== '.') dirty.staged++;
      if (xy[1] !== '.') dirty.modified++;
      if (sub[0] === 'S') dirty.submodules++;
      dirty.entries.push(entry);
      continue;
    }
    if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const t = tokens(line, 10);
      if (t === null) {
        torn = true;
        continue;
      }
      const [, xy = '', sub = NO_SUBMODULE, , , , mW = ''] = t.fields;
      if (xy.length !== 2) {
        torn = true;
        continue;
      }
      dirty.unmerged++;
      if (sub[0] === 'S') dirty.submodules++;
      dirty.entries.push({ xy, sub, path: t.rest, mode: mW });
      continue;
    }
    // unknown record kind: skip it, but say the listing was not fully understood
    torn = true;
  }
  return { head: headOf(oid, headName), upstream, ahead, behind, stash, dirty, torn };
}
