/**
 * Git facts at run start (TUI-DESIGN §12.1, §12.2, D7).
 *
 * Wave 1 ships the pure half: the parser of the five-line `rev-parse` probe, the assembly of a
 * `GitState` from the two probe outputs, the bounded `RunGitMeta` that `run.json` keeps, and
 * the `[run] git …` banner text. `probeGitState` — the two unsandboxed spawns — is wave 2 and
 * is exported here as a typed stub so callers compile; it rejects with a clear message until
 * it is wired. Nothing in this module touches disk, the clock or a child process.
 */
import type { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import type { GitHead, GitState, RunGitMeta } from '../core/types.js';
import type { PorcelainV2 } from './git.js';

/** TUI-DESIGN §12.1: options of the wave-2 probe (`execFile` injectable for the spawn-count test). */
export interface ProbeGitOptions {
  timeoutMs?: number;
  execFile?: typeof execFile;
}

/** TUI-DESIGN §12.1: the five lines of `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel`. */
export interface RevParseFacts {
  insideWorkTree: boolean;
  /** `sub/dir/` with a trailing slash, '' at the top level */
  prefix: string;
  gitDir: string;
  /** a relative `--git-common-dir` is joined onto the probed root (absolute whenever `root` is) */
  commonDir: string;
  topLevel: string;
  /** `gitDir !== commonDir`: a linked worktree of another checkout */
  linkedWorktree: boolean;
}

const PROBE_ARGS: readonly string[] = ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'];
const STATUS_ARGS: readonly string[] = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'];

/** TUI-DESIGN §12.1: the exact argument vectors of the two spawns (shared with the wave-2 probe and its tests). */
export const GIT_PROBE_ARGS: Readonly<{ revParse: readonly string[]; status: readonly string[] }> = { revParse: PROBE_ARGS, status: STATUS_ARGS };

/** Wave-1 stub message; the wave-2 implementation replaces the body, not the signature. */
export const PROBE_NOT_WIRED = 'probeGitState: not wired in wave 1';

/**
 * TUI-DESIGN §12.1: two unsandboxed spawns before the sandbox exists (wave 2). Wave 1 exports the
 * signature only; calling it rejects with `PROBE_NOT_WIRED` so no caller can mistake the stub
 * for a probe that found no repository.
 */
export function probeGitState(root: string, o: ProbeGitOptions = {}): Promise<GitState> {
  void root;
  void o;
  return Promise.reject(new Error(PROBE_NOT_WIRED));
}

function cleanLine(s: string | undefined): string {
  return (s ?? '').replace(/\r$/, '').trim();
}

/**
 * TUI-DESIGN §12.1: parse the `rev-parse` probe's stdout. Returns null when the output is not the
 * five expected lines (git missing, not a repository, torn output): the caller records the reason.
 * A bare repository prints `false` on the first line (and `--show-toplevel` fails, so the fifth
 * line is absent) and is reported with `insideWorkTree: false`. `root` is the probe's `cwd`: a
 * relative `--git-common-dir` is joined onto it lexically (no `process.cwd()`), so the probe passes
 * the resolved workspace root and a relative `root` yields a relative `commonDir`.
 */
export function parseRevParse(stdout: string, root: string): RevParseFacts | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const lines = stdout.split('\n').map(cleanLine);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const inside = lines[0];
  if (inside !== 'true' && inside !== 'false') return null;
  if (inside === 'false') {
    // bare repository: `--show-prefix`/`--show-toplevel` print nothing useful
    const bareGitDir = cleanLine(lines[2] ?? lines[1]);
    if (bareGitDir.length === 0) return null;
    const bareCommon = cleanLine(lines[3] ?? '') || bareGitDir;
    return { insideWorkTree: false, prefix: '', gitDir: bareGitDir, commonDir: isAbsolute(bareCommon) ? normalize(bareCommon) : join(root, bareCommon), topLevel: '', linkedWorktree: false };
  }
  if (lines.length < 5) return null;
  const rawPrefix = lines[1]!;
  const gitDir = lines[2]!;
  const rawCommon = lines[3]!;
  const topLevel = lines[4]!;
  if (gitDir.length === 0 || topLevel.length === 0 || !isAbsolute(gitDir) || !isAbsolute(topLevel)) return null;
  if (rawPrefix.startsWith('/') || rawPrefix.split('/').includes('..')) return null;
  const prefix = rawPrefix.length === 0 ? '' : rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  const commonDir = rawCommon.length === 0 ? gitDir : isAbsolute(rawCommon) ? normalize(rawCommon) : join(root, rawCommon);
  return { insideWorkTree: true, prefix, gitDir, commonDir, topLevel, linkedWorktree: normalize(gitDir) !== commonDir };
}

/** TUI-DESIGN §12.1: the `GitState` of a directory that is not (usably) a repository. */
export function notRepoState(reason: NonNullable<GitState['reason']>, o: { probedAt: string; probeMs: number }): GitState {
  return {
    repo: false,
    reason,
    gitDir: null,
    commonDir: null,
    topLevel: null,
    prefix: '',
    linkedWorktree: false,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
    probedAt: o.probedAt,
    probeMs: sane(o.probeMs),
  };
}

function sane(ms: number): number {
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/**
 * TUI-DESIGN §12.1: assemble the run-start `GitState` from the two probe outputs. A bare repository
 * (`insideWorkTree: false`) is reported as `repo: false, reason: 'bare'` because nothing in it can be
 * edited or restored.
 */
export function buildGitState(rev: RevParseFacts, status: PorcelainV2 | null, o: { probedAt: string; probeMs: number }): GitState {
  if (!rev.insideWorkTree) return notRepoState('bare', o);
  const dirty = status?.dirty ?? { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] };
  return {
    repo: true,
    gitDir: rev.gitDir,
    commonDir: rev.commonDir,
    topLevel: rev.topLevel,
    prefix: rev.prefix,
    linkedWorktree: rev.linkedWorktree,
    head: status?.head ?? null,
    upstream: status?.upstream ?? null,
    ahead: status?.ahead ?? null,
    behind: status?.behind ?? null,
    dirty,
    probedAt: o.probedAt,
    probeMs: sane(o.probeMs),
  };
}

/** TUI-DESIGN §12.1: what `run.json` keeps of the probe — no paths, no entries, the HEAD oid for §12.4's undo rule. */
export function toRunGitMeta(g: GitState): RunGitMeta {
  return {
    repo: g.repo,
    ...(g.reason !== undefined ? { reason: g.reason } : {}),
    head: g.head,
    upstream: g.upstream,
    linkedWorktree: g.linkedWorktree,
    prefix: g.prefix,
    dirtyAtStart: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked },
  };
}

/** TUI-DESIGN §12.1 (P51): the `RunGitMeta.end` block of the run:end re-probe, persisted through `updateMeta({ git })`. */
export function toRunGitMetaEnd(g: GitState): NonNullable<RunGitMeta['end']> {
  return { head: g.head, upstream: g.upstream, ahead: g.ahead, behind: g.behind, dirty: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked } };
}

/** TUI-DESIGN §12.2: the 8-hex abbreviation used in every git line (`7d731c0e`). */
export function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

/** TUI-DESIGN §12.2: the head as the banner and the `--resume` warning print it. */
export function headLabel(head: GitHead | null): string {
  if (head === null) return 'HEAD';
  if (head.kind === 'branch') return head.name;
  if (head.kind === 'detached') return shortOid(head.oid);
  return head.name;
}

/**
 * TUI-DESIGN §12.2: the banner's input is the `workspace` event's `RunGitMeta`; the optional fields
 * carry what the bounded meta lacks at run start — `ahead`/`behind` for `↑2 ↓1` (RunGitMeta keeps
 * them only in `end`), the worktree's main checkout for the linked-worktree line and the unmerged
 * count that lifts the level to `warn` — when the caller has the full `GitState`.
 */
export type GitBannerInput = RunGitMeta & { ahead?: number | null; behind?: number | null; commonDir?: string | null; unmerged?: number };

/** TUI-DESIGN §12.2: `GitState` → banner input (adds ahead/behind, the worktree path and the unmerged count). */
export function bannerInput(g: GitState): GitBannerInput {
  return { ...toRunGitMeta(g), ahead: g.ahead, behind: g.behind, commonDir: g.commonDir, unmerged: g.dirty.unmerged };
}

/**
 * TUI-DESIGN §12.2: the tail of the `git none · …` banner per `GitState.reason`. §12.2 names the not-a-repo and
 * git-missing texts; a bare repository and a probe timeout have their own (see the O5 report) so the cause is never
 * misreported as "not a git repository".
 */
export function notRepoReason(reason: GitState['reason']): string {
  switch (reason) {
    case 'git-missing':
      return 'git not found on PATH: /undo and /diff use step pre-images only';
    case 'timeout':
      return 'git did not answer in time: /undo and /diff use step pre-images only';
    case 'bare':
      return 'bare repository: no work tree to edit; /undo and /diff use step pre-images only';
    default:
      return 'not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only';
  }
}

/** TUI-DESIGN §12.2: one `[run] git …` line (the label is added by the item formatter), `warn` only for unmerged paths. */
export function gitBannerLine(git: GitBannerInput, opts: { ascii?: boolean } = {}): { text: string; level: 'info' | 'warn' } {
  const ascii = opts.ascii === true;
  const sep = ascii ? ' - ' : ' · ';
  if (!git.repo) return { text: `git none${sep}${notRepoReason(git.reason)}`, level: 'info' };
  const head = git.head;
  let text = 'git ';
  if (head === null) text += 'HEAD';
  else if (head.kind === 'detached') text += `detached ${shortOid(head.oid)}`;
  else if (head.kind === 'unborn') text += `${head.name} (unborn, no commits yet)`;
  else text += head.name;
  if (git.linkedWorktree) {
    const common = typeof git.commonDir === 'string' && git.commonDir.length > 0 ? dirname(git.commonDir) : null;
    text += common === null ? ' (linked worktree)' : ` (linked worktree of ${common})`;
  }
  if (git.upstream !== null) {
    const ahead = git.ahead ?? 0;
    const behind = git.behind ?? 0;
    if (ahead > 0) text += ` ${ascii ? '^' : '↑'}${ahead}`;
    if (behind > 0) text += ` ${ascii ? 'v' : '↓'}${behind}`;
  }
  const d = git.dirtyAtStart;
  const parts: string[] = [];
  if (d.modified > 0) parts.push(`${d.modified} modified`);
  if (d.staged > 0) parts.push(`${d.staged} staged`);
  if (d.untracked > 0) parts.push(`${d.untracked} untracked`);
  const unmerged = git.unmerged ?? 0;
  const subdir = git.prefix.length > 0 ? `in subdirectory ${git.prefix} of the repository` : null;
  if (parts.length > 0) text += `${sep}${parts.join(sep)}`;
  else if (subdir === null && unmerged === 0) text += `${sep}clean`;
  if (subdir !== null) text += `${sep}${subdir}`;
  if (unmerged > 0) text += `${sep}working tree has unmerged paths (u) ${ascii ? '-' : '—'} commands may fail on conflict markers`;
  return { text, level: unmerged > 0 ? 'warn' : 'info' };
}

/** TUI-DESIGN §12.2 (P52): the `--resume` warning when HEAD moved since the run started. */
export function headDriftWarning(startedOn: GitHead | null, now: GitHead | null): string {
  return `warning: HEAD was ${headLabel(startedOn)} at run start, now ${headLabel(now)} — the plan may not apply`;
}

/** TUI-DESIGN §12.2: true when two heads name a different commit (or a different ref when no oid is known). */
export function headMoved(a: GitHead | null, b: GitHead | null): boolean {
  if (a === null || b === null) return a !== b;
  const oa = a.kind === 'unborn' ? null : a.oid;
  const ob = b.kind === 'unborn' ? null : b.oid;
  if (oa !== null && ob !== null) return oa !== ob;
  return a.kind !== b.kind || headLabel(a) !== headLabel(b);
}
