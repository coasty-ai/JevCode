/**
 * The only module that spawns git (DESIGN.md §8, defence 2).
 *
 * A `run` action may plant `core.fsmonitor`, hooks, `diff.external` or a pager in the
 * workspace's `.git/config`; ordinary harness commands (`status`, `ls-files`, `diff`) would
 * execute them with the harness's environment. So every harness git call goes through the
 * sandbox with the scrubbed env plus GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL=/dev/null and
 * `-c` overrides that neutralise the executable knobs. Output is untrusted text: bounded and
 * parsed defensively.
 */
import { dirname } from 'node:path';

import type { ExecResult, Sandbox } from '../core/types.js';

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

/** `git ls-files --error-unmatch -- <path>` succeeds only for tracked paths. */
export async function lsFilesTracked(sandbox: Sandbox, ws: string, relPath: string, opts: GitRunOptions = {}): Promise<boolean> {
  const r = await runGit(sandbox, ws, ['ls-files', '--error-unmatch', '-z', '--', relPath], opts);
  return r.ok && r.stdout.length > 0;
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
